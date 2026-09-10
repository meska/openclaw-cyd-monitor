import type { CommandRunner, PluginOptions, StatusSnapshot } from "./types.js";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function snapshotFromPayload(
  payload: JsonObject,
  activePayload: JsonObject = {},
  workboardPayload: JsonObject = {},
  nowMs: number = Date.now(),
): StatusSnapshot {
  const gateway = asObject(payload.gateway);
  const sessions = asObject(payload.sessions);
  const recent = asArray(sessions.recent).map(asObject);
  const newest = recent[0] ?? {};
  const tasks = asObject(payload.tasks);
  const agents = asArray(asObject(payload.agents).agents);
  const heartbeatAgents = asArray(asObject(payload.heartbeat).agents).map(asObject);
  const activeItems = asArray(activePayload.sessions).map(asObject);
  const workboardCards = asArray(workboardPayload.cards).map(asObject);

  const cardsWithStatus = (expected: string): number =>
    workboardCards.filter(
      (item) => item.status === expected && !asObject(item.metadata).archivedAt,
    ).length;

  const cutoffMs = nowMs - 86_400_000;
  // Conta el lavoro finio, no le card vecie che dorme in archivio.
  const done24h = workboardCards.filter(
    (item) =>
      item.status === "done" &&
      !asObject(item.metadata).archivedAt &&
      asInteger(item.completedAt) >= cutoffMs,
  ).length;

  const freshTokenItems = activeItems.filter(
    (item) =>
      item.totalTokensFresh === true &&
      typeof item.totalTokens === "number" &&
      asInteger(item.contextTokens) > 0,
  );
  const tokenCapacity = freshTokenItems.reduce(
    (total, item) => total + asInteger(item.contextTokens),
    0,
  );
  const tokenUsage = freshTokenItems.reduce(
    (total, item) => total + asInteger(item.totalTokens),
    0,
  );
  const rawModel = newest.model ?? newest.configuredModel ?? "unknown";
  const model = typeof rawModel === "string" ? rawModel.slice(0, 31) : "unknown";

  return {
    schema: 2,
    ok: Boolean(gateway.reachable),
    collectedAtMs: nowMs,
    gateway: {
      online: Boolean(gateway.reachable),
      latencyMs: asInteger(gateway.connectLatencyMs),
    },
    sessions: {
      total: asInteger(sessions.count),
      recent: recent.length,
      active: asInteger(activePayload.count),
      tokenLoadPercent: tokenCapacity
        ? Math.min(100, Math.round((tokenUsage * 100) / tokenCapacity))
        : 0,
      tokenSamples: freshTokenItems.length,
      model,
    },
    tasks: {
      active: asInteger(tasks.active),
      failures: asInteger(tasks.failures),
    },
    agents: {
      total: agents.length,
      heartbeatEnabled: heartbeatAgents.filter((item) => Boolean(item.enabled)).length,
    },
    system: {
      version: String(payload.runtimeVersion ?? "unknown").slice(0, 23),
      queuedEvents: asArray(payload.queuedSystemEvents).length,
      degradedPlugins: asArray(payload.degradedPlugins).length,
    },
    workboard: {
      triage: cardsWithStatus("triage"),
      running: cardsWithStatus("running"),
      blocked: cardsWithStatus("blocked"),
      done24h,
    },
  };
}

export class OpenClawCollector {
  public constructor(
    private readonly runCommand: CommandRunner,
    private readonly options: PluginOptions,
  ) {}

  public async collect(): Promise<StatusSnapshot> {
    // Le tre letture xe indipendenti: in parallelo el display no aspetta la somma dei CLI.
    const [status, active, workboard] = await Promise.all([
      this.runJson(["status", "--json"]),
      this.runJson([
        "sessions",
        "--all-agents",
        "--active",
        String(this.options.activeMinutes),
        "--limit",
        "all",
        "--json",
      ]),
      // Workboard xe opzionale in OpenClaw: senza plugin mostremo zeri, no un display rotto.
      this.runJson(["workboard", "list", "--board", this.options.workboard, "--json"]).catch(
        () => ({}),
      ),
    ]);
    return snapshotFromPayload(status, active, workboard);
  }

  private async runJson(args: string[]): Promise<JsonObject> {
    const result = await this.runCommand([this.options.executable, ...args], {
      timeoutMs: this.options.timeoutMs,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.code !== 0 || result.termination !== "exit") {
      const detail = result.stderr.trim().slice(0, 160);
      throw new Error(
        `OpenClaw ${args.join(" ")} failed (${result.termination}, code ${String(result.code)})${detail ? `: ${detail}` : ""}`,
      );
    }

    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`OpenClaw ${args.join(" ")} returned a non-object payload`);
    }
    return parsed as JsonObject;
  }
}
