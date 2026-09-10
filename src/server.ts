import { createServer, type Server } from "node:http";

import type { Logger, PluginOptions, StatusSnapshot } from "./types.js";

export interface SnapshotCollector {
  collect(): Promise<StatusSnapshot>;
}

export class SnapshotCache {
  private snapshot: StatusSnapshot | undefined;
  private error = "warming up";
  private timer: NodeJS.Timeout | undefined;
  private currentRefresh: Promise<void> | undefined;
  private stopping = false;

  public constructor(
    private readonly collector: SnapshotCollector,
    private readonly intervalMs: number,
    private readonly logger: Logger,
  ) {}

  public start(): void {
    this.stopping = false;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.currentRefresh;
  }

  public payload(): { body: StatusSnapshot | { schema: 2; ok: false; error: string }; status: number } {
    if (!this.snapshot) {
      return { body: { schema: 2, ok: false, error: this.error }, status: 503 };
    }
    if (!this.error) return { body: this.snapshot, status: 200 };
    return {
      body: { ...this.snapshot, stale: true, error: this.error },
      status: 200,
    };
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.currentRefresh = this.refresh().finally(() => {
        this.currentRefresh = undefined;
        if (!this.stopping) this.schedule(this.intervalMs);
      });
    }, delayMs);
  }

  private async refresh(): Promise<void> {
    try {
      this.snapshot = await this.collector.collect();
      this.error = "";
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 160) : "unknown error";
      // El client LAN riceve solo un errore neutro; percorsi e stderr resta nei log locali.
      this.error = "status refresh failed";
      this.logger.warn(`Status refresh failed: ${detail}`);
    }
  }
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
    private readonly cache: SnapshotCache,
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
        const payload = this.cache.payload();
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
