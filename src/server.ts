import { createServer, type Server } from "node:http";

import {
  EMPTY_SLOW_PART,
  SessionRowCache,
  sessionStatusFromRows,
  type SlowStatusPart,
} from "./collector.js";
import type { Logger, PluginOptions, SessionLister, StatusSnapshot } from "./types.js";

export interface StatusCoordinatorDeps {
  options: PluginOptions;
  logger: Logger;
  listSessions: SessionLister;
  getAgentIds: () => string[];
  collectSlowPart: () => Promise<SlowStatusPart>;
  now?: () => number;
}

/**
 * Niente piu' timer e niente piu' scan sincrono sulla richiesta: il fetch del
 * CYD ha 4 s di timeout e il scan completo (tutti gli agenti) costava 1-2,5 s.
 * - Fast: cache per agente, rescan in background (single-flight) solo degli
 *   agenti sporchi (evento sessions.changed) o scaduti; le finestre temporali
 *   si ricalcolano in memoria ad ogni richiesta.
 * - Slow: ciclo CLI seriale (status + workboard), single-flight, solo se scaduto.
 * Display staccato = zero subprocess, zero query; display attivo = risposte
 * sempre immediate, dalla cache.
 */
export class StatusCoordinator {
  private readonly now: () => number;
  private readonly rowCache = new SessionRowCache();
  private slowPart: SlowStatusPart | undefined;
  private fastError = "";
  private slowError = "";
  private warmedUp = false;
  private lastFastAt = 0;
  private lastSlowAt = 0;
  private fastScanMs = 0;
  private fastInFlight: Promise<void> | undefined;
  private slowInFlight: Promise<void> | undefined;

  public constructor(private readonly deps: StatusCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  public markSessionsDirty(agentId?: string): void {
    this.rowCache.markDirty(agentId);
  }

  public reset(): void {
    this.rowCache.reset();
    this.slowPart = undefined;
    this.fastError = "";
    this.slowError = "";
    this.warmedUp = false;
    this.lastFastAt = 0;
    this.lastSlowAt = 0;
    this.fastInFlight = undefined;
    this.slowInFlight = undefined;
  }

  public request(): { body: StatusSnapshot | { schema: 2; ok: false; error: string }; status: number } {
    const now = this.now();
    if (
      !this.fastInFlight &&
      (!this.warmedUp || this.rowCache.hasDirty || now - this.lastFastAt >= this.deps.options.fastTtlMs)
    ) {
      // In background: el display no aspetta mai el scan.
      this.fastInFlight = this.refreshFast(now).finally(() => {
        this.fastInFlight = undefined;
      });
    }
    if (
      !this.slowInFlight &&
      (this.slowPart === undefined || now - this.lastSlowAt >= this.deps.options.slowTtlMs)
    ) {
      this.slowInFlight = this.refreshSlow().finally(() => {
        this.slowInFlight = undefined;
      });
    }

    if (!this.warmedUp && this.slowPart === undefined) {
      return { body: { schema: 2, ok: false, error: this.fastError || "warming up" }, status: 503 };
    }

    // Finestre temporali ricalcolate dalla cache: costo in memoria, zero DB.
    const sessions = sessionStatusFromRows(
      this.rowCache.allRows(),
      this.deps.options.activeMinutes,
      now,
    );
    const slow = this.slowPart ?? EMPTY_SLOW_PART;
    const errors = [this.fastError, this.slowError].filter(Boolean);

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
    } else if (!this.warmedUp || this.slowPart === undefined) {
      body.stale = true;
      body.error = "warming up";
    }
    return { body, status: 200 };
  }

  public async stop(): Promise<void> {
    await Promise.all([this.fastInFlight, this.slowInFlight]);
  }

  private refreshFast(now: number): Promise<void> {
    // setImmediate: la risposta HTTP parte PRIMA del scan, poi el scan corre.
    // El fetch del CYD ha 4 s di timeout: mai bloccarlo sulla lettura store.
    return new Promise<void>((resolve) => {
      setImmediate(() => {
        const startedAt = this.now();
        try {
          this.rowCache.refresh(this.deps.listSessions, this.deps.getAgentIds(), now);
          this.fastScanMs = Math.max(0, this.now() - startedAt);
          this.fastError = "";
        } catch (error) {
          // El client LAN riceve solo un errore neutro; i dettagli resta nei log locali.
          this.fastError = "status refresh failed";
          this.deps.logger.warn(`Fast session scan failed: ${describe(error)}`);
        }
        this.warmedUp = true;
        this.lastFastAt = now;
        resolve();
      });
    });
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
