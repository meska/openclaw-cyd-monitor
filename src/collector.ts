import type {
  AgentStatus,
  CommandRunner,
  PluginOptions,
  SessionLister,
  SessionRowSummary,
  SessionStatus,
  SystemStatus,
  TaskStatus,
  WorkboardStatus,
} from "./types.js";

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
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return 0;
}

/** Tira fora el primo campo numerico coerente tra i nomi candidati. */
function pickNumber(entry: JsonObject, names: string[]): number | undefined {
  for (const name of names) {
    const value = entry[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function pickBoolean(entry: JsonObject, names: string[]): boolean | undefined {
  for (const name of names) {
    const value = entry[name];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function rowUpdatedAt(row: SessionRowSummary): number {
  return pickNumber(row.entry, ["updatedAt", "lastActivity", "touchedAt"]) ?? 0;
}

/** Agenti configurati + main: el perimetro del scan in-process. */
export function agentsFromConfig(config: { agents?: Record<string, unknown> }): string[] {
  const ids = new Set<string>(["main"]);
  for (const id of Object.keys(config.agents ?? {})) ids.add(id);
  return [...ids];
}

export function listAllSessionRows(
  listSessions: SessionLister,
  agentIds: string[],
): SessionRowSummary[] {
  const rows: SessionRowSummary[] = [];
  // Un agente rotto no deve fermare i altri: el display mostra quel che ghe xe.
  for (const agentId of agentIds) {
    try {
      rows.push(...(listSessions({ agentId, readOnly: true }) ?? []));
    } catch {
      // Agente senza store o non ancora inizializzato: saltalo e via.
    }
  }
  return rows;
}

/**
 * Cache per agente delle righe sessione: el scan completo (10 agenti, ~1000
 * righe) costava 1-2,5 s sincroni e mandava in timeout il fetch del CYD.
 * Ora si rescanna solo l'agente sporco (evento) o scaduto; il resto served
 * dalla cache e le finestre temporali si ricalcolano in memoria.
 */
export class SessionRowCache {
  private readonly rows = new Map<string, SessionRowSummary[]>();
  private readonly scannedAt = new Map<string, number>();
  private readonly dirty = new Set<string>();

  public constructor(private readonly maxAgeMs: number = 600_000) {}

  public markDirty(agentId?: string): void {
    if (agentId === undefined) {
      // Senza agentId no sae chi è cambià: sporco tutto alla prossima.
      this.dirty.add("__all__");
      return;
    }
    this.dirty.add(agentId);
  }

  public reset(): void {
    this.rows.clear();
    this.scannedAt.clear();
    this.dirty.clear();
    this.dirty.add("__all__");
  }

  public allRows(): SessionRowSummary[] {
    const out: SessionRowSummary[] = [];
    for (const list of this.rows.values()) out.push(...list);
    return out;
  }

  public get isEmpty(): boolean {
    return this.rows.size === 0;
  }

  public get hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  /** Riscansiona solo gli agenti sporchi, nuovi o troppo vecchi. */
  public refresh(
    listSessions: SessionLister,
    agentIds: string[],
    nowMs: number,
  ): { scanned: string[] } {
    const forceAll = this.dirty.has("__all__");
    const scanned: string[] = [];
    for (const agentId of agentIds) {
      const cached = this.rows.has(agentId);
      const stale = !cached || nowMs - (this.scannedAt.get(agentId) ?? 0) >= this.maxAgeMs;
      const dirty = forceAll || !cached || this.dirty.has(agentId);
      if (!stale && !dirty) continue;
      try {
        this.rows.set(agentId, listSessions({ agentId, readOnly: true }) ?? []);
        this.scannedAt.set(agentId, nowMs);
        this.dirty.delete(agentId);
        scanned.push(agentId);
      } catch {
        // Agente illeggibile: tieni la copia vecia, se la ghe xe.
      }
    }
    this.dirty.delete("__all__");
    return { scanned };
  }
}

export function sessionStatusFromRows(
  rows: SessionRowSummary[],
  activeMinutes: number,
  nowMs: number,
): SessionStatus {
  const activeCutoffMs = nowMs - activeMinutes * 60_000;
  const recentCutoffMs = nowMs - 86_400_000;

  const active = rows.filter((row) => rowUpdatedAt(row) >= activeCutoffMs);
  const activeSorted = [...active].sort((a, b) => rowUpdatedAt(b) - rowUpdatedAt(a));
  const newest = activeSorted[0];

  let tokenCapacity = 0;
  let tokenUsage = 0;
  let tokenSamples = 0;
  for (const row of activeSorted) {
    const fresh = pickBoolean(row.entry, ["totalTokensFresh", "tokensFresh", "tokenUsageFresh"]);
    const total = pickNumber(row.entry, ["totalTokens", "tokens", "total_tokens"]);
    const context = pickNumber(row.entry, ["contextTokens", "contextWindowTokens", "context_window"]);
    if (fresh !== true || total === undefined || context === undefined || context <= 0) continue;
    tokenCapacity += context;
    tokenUsage += total;
    tokenSamples += 1;
  }

  const rawModel = newest?.entry.model ?? newest?.entry.configuredModel ?? "unknown";
  const model = typeof rawModel === "string" ? rawModel.slice(0, 31) : "unknown";

  return {
    total: rows.length,
    recent: rows.filter((row) => rowUpdatedAt(row) >= recentCutoffMs).length,
    active: active.length,
    tokenLoadPercent: tokenCapacity
      ? Math.min(100, Math.round((tokenUsage * 100) / tokenCapacity))
      : 0,
    tokenSamples,
    model,
  };
}

export interface SlowStatusPart {
  tasks: TaskStatus;
  agents: AgentStatus;
  system: SystemStatus;
  workboard: WorkboardStatus;
}

const EMPTY_SLOW_PART: SlowStatusPart = {
  tasks: { active: 0, failures: 0 },
  agents: { total: 0, heartbeatEnabled: 0 },
  system: { version: "unknown", queuedEvents: 0, degradedPlugins: 0 },
  workboard: { triage: 0, running: 0, blocked: 0, done24h: 0 },
};

/**
 * Aggregati lenti dal payload RPC status + Workboard: stessi conteggi della
 * 0.3.x, ma ora li si va a cercare una volta al minuto, non ogni 5 secondi.
 */
export function slowPartFromPayloads(
  payload: JsonObject,
  workboardPayload: JsonObject,
  nowMs: number = Date.now(),
): SlowStatusPart {
  const tasks = asObject(payload.tasks);
  const projection = asObject(payload.cliProjection);
  const agents =
    asArray(asObject(projection.agents).rows).length > 0
      ? asArray(asObject(projection.agents).rows)
      : asArray(asObject(payload.agents).agents);
  const heartbeatAgents = asArray(asObject(payload.heartbeat).agents).map(asObject);
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

  return {
    tasks: { active: asInteger(tasks.active), failures: asInteger(tasks.failures) },
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

/** Ciclo lento: due letture CLI **seriali**, mai in parallelo. */
export class SlowCycleCollector {
  public constructor(
    private readonly runCommand: CommandRunner,
    private readonly options: PluginOptions,
  ) {}

  public async collect(): Promise<{ status: JsonObject; workboard: JsonObject }> {
    const status = await this.collectGatewayStatus();
    // Workboard xe opzionale in OpenClaw: senza plugin mostremo zeri, no un display rotto.
    const workboard = await this.collectWorkboard().catch(() => ({}) as JsonObject);
    return { status, workboard };
  }

  private async collectGatewayStatus(): Promise<JsonObject> {
    // La CLI status fa un probe system-presence prima della proiezion: col token
    // del plugin vien FORBIDDEN. La RPC status dà gli stessi aggregati senza quel probe.
    return this.runJson([
      "gateway",
      "call",
      "status",
      "--params",
      '{"includeChannelSummary":false,"includeCliProjection":true}',
      "--json",
    ]);
  }

  private async collectWorkboard(): Promise<JsonObject> {
    if (this.options.workboard !== "all") {
      return this.runJson(["workboard", "list", "--board", this.options.workboard, "--json"]);
    }

    const globalPayload = await this.runJson(["workboard", "list", "--json"]);
    const globalCards = asArray(globalPayload.cards);
    if (globalCards.length !== 50) return globalPayload;

    // Le version vecie tagliava la lista globale a 50; el fallback seriale evita quattro CLI in gara.
    const cards: unknown[] = [];
    for (const status of ["triage", "running", "blocked", "done"]) {
      const payload = await this.runJson(["workboard", "list", "--status", status, "--json"]);
      cards.push(...asArray(payload.cards));
    }
    return { cards };
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

export { EMPTY_SLOW_PART };
