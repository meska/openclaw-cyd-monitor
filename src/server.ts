import { createServer, type Server } from "node:http";

import {
  EMPTY_SLOW_PART,
  listAllSessionRows,
  sessionStatusFromRows,
  type SlowStatusPart,
} from "./collector.js";
import type {
  Logger,
  PluginOptions,
  SessionLister,
  SessionStatus,
  StatusSnapshot,
} from "./types.js";

const EMPTY_SESSION_STATUS: SessionStatus = {
  total: 0,
  recent: 0,
  active: 0,
  tokenLoadPercent: 0,
  tokenSamples: 0,
  model: "unknown",
};

export interface StatusCoordinatorDeps {
  options: PluginOptions;
  logger: Logger;
  listSessions: SessionLister;
  getAgentIds: () => string[];
  collectSlowPart: () => Promise<SlowStatusPart>;
  now?: () => number;
}

/**
 * Niente piu' timer: el display xe l'unico client e decide lui quando si spende.
 * - Fast: scan sessioni in-process, a richiesta o su evento sessions.changed.
 * - Slow: ciclo CLI seriale (status + workboard), single-flight, solo se scaduto.
 * Display staccato = zero subprocess, zero letture DB.
 */
export class StatusCoordinator {
  private readonly now: () => number;
  private sessionStatus: SessionStatus | undefined;
  private slowPart: SlowStatusPart | undefined;
  private fastDirty = true;
  private fastError = "";
  private slowError = "";
  private lastFastAt = 0;
  private lastSlowAt = 0;
  private fastScanMs = 0;
  private slowInFlight: Promise<void> | undefined;

  public constructor(private readonly deps: StatusCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  public markSessionsDirty(): void {
    this.fastDirty = true;
  }

  public reset(): void {
    this.sessionStatus = undefined;
    this.slowPart = undefined;
    this.fastDirty = true;
    this.fastError = "";
    this.slowError = "";
    this.lastFastAt = 0;
    this.lastSlowAt = 0;
    this.slowInFlight = undefined;
  }

  public request(): { body: StatusSnapshot | { schema: 2; ok: false; error: string }; status: number } {
    const now = this.now();
    if (this.fastDirty || now - this.lastFastAt >= this.deps.options.fastTtlMs) {
      this.refreshFast(now);
    }
    if (
      !this.slowInFlight &&
      (this.slowPart === undefined || now - this.lastSlowAt >= this.deps.options.slowTtlMs)
    ) {
      // Fire-and-forget: el display pol servisarse co i dati de un minuto fa.
      this.slowInFlight = this.refreshSlow().finally(() => {
        this.slowInFlight = undefined;
      });
    }

    if (this.sessionStatus === undefined && this.slowPart === undefined) {
      return { body: { schema: 2, ok: false, error: this.fastError || "warming up" }, status: 503 };
    }

    const sessions = this.sessionStatus ?? EMPTY_SESSION_STATUS;
    const slow = this.slowPart ?? EMPTY_SLOW_PART;
    const errors = [this.fastError, this.slowError].filter(Boolean);
    const warming = this.slowPart === undefined && !this.slowError;

    const body: StatusSnapshot = {
      schema: 2,
      // Se stiamo rispondendo, el Gateway el xe vivo per definizion.
      ok: true,
      collectedAtMs: now,
      gateway: { online: true, latencyMs: this.fastScanMs },
      sessions,
      tasks: slow.tasks,
      agents: slow.agents,
      system: slow.system,
      workboard: slow.workboard,
    };
    if (errors.length > 0) {
      body.stale = true;
      body.error = errors[0] ?? "status refresh failed";
    } else if (warming) {
      body.stale = true;
      body.error = "warming up";
    }
    return { body, status: 200 };
  }

  public async stop(): Promise<void> {
    await this.slowInFlight;
  }

  private refreshFast(now: number): void {
    const startedAt = this.now();
    try {
      const rows = listAllSessionRows(this.deps.listSessions, this.deps.getAgentIds());
      this.sessionStatus = sessionStatusFromRows(rows, this.deps.options.activeMinutes, now);
      this.fastScanMs = Math.max(0, this.now() - startedAt);
      this.fastError = "";
    } catch (error) {
      // El client LAN riceve solo un errore neutro; i dettagli resta nei log locali.
      this.fastError = "status refresh failed";
      this.deps.logger.warn(`Fast session scan failed: ${describe(error)}`);
    }
    this.fastDirty = false;
    this.lastFastAt = now;
  }

  private async refreshSlow(): Promise<void> {
    try {
      const part = await this.deps.collectSlowPart();
      this.slowPart = part;
      this.lastSlowAt = this.now();
      this.slowError = "";
    } catch (error) {
      this.slowError = "status refresh failed";
      this.deps.logger.warn(`Slow status cycle failed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : "unknown error";
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": encoded.byteLength,
    Connection: "close",
  });
  response.end(encoded);
}

export class MonitorServer {
  private server: Server | undefined;

  public constructor(
    private readonly options: PluginOptions,
    private readonly coordinator: StatusCoordinator,
    private readonly logger: Logger,
  ) {}

  public async start(): Promise<void> {
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method !== "GET") {
        sendJson(response, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (path === "/api/status") {
        const payload = this.coordinator.request();
        sendJson(response, payload.status, payload.body);
        return;
      }
      if (path === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not found" });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    this.logger.info(
      `Serving sanitized status on http://${this.options.host}:${this.options.port}/api/status`,
    );
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
