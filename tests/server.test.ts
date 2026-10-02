import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusCoordinator } from "../src/server.js";
import type { SlowStatusPart } from "../src/collector.js";
import type { Logger, PluginOptions, SessionLister, SessionRowSummary } from "../src/types.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const options: PluginOptions = {
  host: "0.0.0.0",
  port: 8765,
  fastTtlMs: 30_000,
  slowTtlMs: 60_000,
  timeoutMs: 60_000,
  activeMinutes: 15,
  workboard: "all",
  executable: "openclaw",
};

const slowPart: SlowStatusPart = {
  tasks: { active: 2, failures: 1 },
  agents: { total: 4, heartbeatEnabled: 3 },
  system: { version: "2026.9.7", queuedEvents: 1, degradedPlugins: 0 },
  workboard: { triage: 2, running: 1, blocked: 0, done24h: 5 },
};

const mainRow: SessionRowSummary = {
  sessionKey: "agent:main:telegram:topic-1",
  entry: { updatedAt: 199_500_000, model: "gpt-test", totalTokensFresh: true, totalTokens: 40, contextTokens: 100 },
};
const opsRow: SessionRowSummary = {
  sessionKey: "agent:ops:task-1",
  entry: { updatedAt: 50_000_000 },
};

afterEach(() => {
  vi.clearAllMocks();
});

function buildCoordinator(overrides?: {
  collectSlowPart?: () => Promise<SlowStatusPart>;
  listSessions?: SessionLister;
  getAgentIds?: () => string[];
}) {
  let fakeNow = 200_000_000;
  const listSessions: SessionLister = vi.fn((params) =>
    params?.agentId === "ops" ? [opsRow] : [mainRow],
  );
  const collectSlowPart = vi.fn(() => Promise.resolve(slowPart));
  const coordinator = new StatusCoordinator({
    options,
    logger,
    listSessions: overrides?.listSessions ?? listSessions,
    getAgentIds: overrides?.getAgentIds ?? (() => ["main", "ops"]),
    collectSlowPart: overrides?.collectSlowPart ?? collectSlowPart,
    now: () => fakeNow,
  });
  return {
    coordinator,
    listSessions,
    collectSlowPart,
    flush: () => coordinator.stop(),
    advance: (ms: number) => {
      fakeNow += ms;
    },
  };
}

describe("StatusCoordinator", () => {
  it("answers warming up without blocking, then serves cached rows and slow data", async () => {
    const { coordinator, listSessions, collectSlowPart, flush } = buildCoordinator();

    // Prima risposta immediata: el scan corse dopo, mica prima.
    const first = coordinator.request();
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ ok: false, error: "warming up" });
    expect(listSessions).toHaveBeenCalledTimes(0);
    expect(collectSlowPart).toHaveBeenCalledTimes(1);

    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);

    const second = coordinator.request();
    expect(second.status).toBe(200);
    expect(second.body).not.toHaveProperty("stale");
    expect(second.body).toMatchObject({
      sessions: { total: 2, active: 1, tokenLoadPercent: 40, model: "gpt-test" },
      tasks: slowPart.tasks,
      workboard: slowPart.workboard,
    });
  });

  it("rescans only the dirty agent flagged by the gateway event", async () => {
    const { coordinator, listSessions, flush } = buildCoordinator();
    coordinator.request();
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);

    // Dentro el TTL: nessuna nuova lettura.
    coordinator.request();
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(2);

    coordinator.markSessionsDirty("ops");
    coordinator.request();
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(listSessions).toHaveBeenLastCalledWith({ agentId: "ops", readOnly: true });
  });

  it("collapses concurrent fast refreshes into one scan", async () => {
    const { coordinator, listSessions, flush } = buildCoordinator();
    coordinator.request();
    await flush();

    coordinator.markSessionsDirty();
    coordinator.request();
    coordinator.request();
    await flush();
    // Una sola passata su doi agenti, no doi.
    expect(listSessions).toHaveBeenCalledTimes(4);
  });

  it("keeps a single slow cycle in flight and refreshes only after the slow TTL", async () => {
    const { coordinator, collectSlowPart, advance, flush } = buildCoordinator();
    coordinator.request();
    await flush();

    advance(options.slowTtlMs + 1);
    coordinator.request();
    coordinator.request();
    expect(collectSlowPart).toHaveBeenCalledTimes(2);

    advance(1_000);
    coordinator.request();
    expect(collectSlowPart).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("marks the snapshot stale but keeps the last slow data when the CLI cycle fails", async () => {
    let failing = false;
    const { coordinator, advance, flush } = buildCoordinator({
      collectSlowPart: async () => {
        if (failing) throw new Error("timeout");
        return slowPart;
      },
    });
    coordinator.request();
    await flush();

    failing = true;
    advance(options.slowTtlMs + 1);
    coordinator.request();
    await flush();

    const payload = coordinator.request();
    expect(payload.status).toBe(200);
    expect(payload.body).toMatchObject({
      stale: true,
      error: "status refresh failed",
      workboard: slowPart.workboard,
      tasks: slowPart.tasks,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("serves zeros with a stale flag when the fast scan itself fails", async () => {
    const { coordinator } = buildCoordinator({
      getAgentIds: () => {
        throw new Error("config unavailable");
      },
      collectSlowPart: () => new Promise<SlowStatusPart>(() => undefined),
    });
    const first = coordinator.request();
    expect(first.status).toBe(503);
    // El ciclo lento no se risolve mai in sto test: se aspetta solo el fast (un tick).
    await new Promise((resolve) => setImmediate(resolve));

    const second = coordinator.request();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      stale: true,
      error: "status refresh failed",
      sessions: { total: 0, active: 0, model: "unknown" },
    });
  });
});
