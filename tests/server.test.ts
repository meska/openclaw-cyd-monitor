import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusCoordinator } from "../src/server.js";
import type { SlowStatusPart } from "../src/collector.js";
import type { Logger, PluginOptions, SessionRowSummary } from "../src/types.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const options: PluginOptions = {
  host: "0.0.0.0",
  port: 8765,
  fastTtlMs: 15_000,
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

const activeRow: SessionRowSummary = {
  sessionKey: "agent:main:telegram:topic-1",
  entry: { updatedAt: 1_000, model: "gpt-test", totalTokensFresh: true, totalTokens: 40, contextTokens: 100 },
};

afterEach(() => {
  vi.clearAllMocks();
});

function buildCoordinator(overrides?: {
  collectSlowPart?: () => Promise<SlowStatusPart>;
  listSessions?: (params?: { agentId?: string }) => SessionRowSummary[];
  getAgentIds?: () => string[];
}) {
  let fakeNow = 10_000;
  const listSessions = vi.fn(() => [activeRow]);
  const collectSlowPart = vi.fn(() => Promise.resolve(slowPart));
  const coordinator = new StatusCoordinator({
    options,
    logger,
    listSessions: overrides?.listSessions ?? listSessions,
    getAgentIds: overrides?.getAgentIds ?? (() => ["main"]),
    collectSlowPart: overrides?.collectSlowPart ?? collectSlowPart,
    now: () => fakeNow,
  });
  return {
    coordinator,
    listSessions,
    collectSlowPart,
    advance: (ms: number) => {
      fakeNow += ms;
    },
    setNow: (ms: number) => {
      fakeNow = ms;
    },
  };
}

describe("StatusCoordinator", () => {
  it("serves the fast layer immediately and warms the slow cycle in background", async () => {
    const { coordinator, listSessions, collectSlowPart } = buildCoordinator();
    const first = coordinator.request();

    // El display no aspetta la CLI: le sessioni le ga xà, el ciclo lento scaldà.
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      stale: true,
      error: "warming up",
      sessions: { active: 1, tokenLoadPercent: 40, model: "gpt-test" },
    });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(collectSlowPart).toHaveBeenCalledTimes(1);

    await coordinator.stop();
    const second = coordinator.request();
    expect(second.body).not.toHaveProperty("stale");
    expect(second.body).toMatchObject({
      tasks: slowPart.tasks,
      workboard: slowPart.workboard,
      sessions: { active: 1 },
    });
  });

  it("respects the fast TTL and the dirty flag from gateway events", () => {
    const { coordinator, listSessions } = buildCoordinator();
    coordinator.request();
    expect(listSessions).toHaveBeenCalledTimes(1);

    // Dentro el TTL: niente rescan.
    coordinator.request();
    expect(listSessions).toHaveBeenCalledTimes(1);

    // Evento push: rescan subito, anca dentro el TTL.
    coordinator.markSessionsDirty();
    coordinator.request();
    expect(listSessions).toHaveBeenCalledTimes(2);

    // TTL scaduto: rescan.
    const { coordinator: other, listSessions: otherList, advance } = buildCoordinator();
    other.request();
    advance(options.fastTtlMs + 1);
    other.request();
    expect(otherList).toHaveBeenCalledTimes(2);
  });

  it("keeps a single slow cycle in flight and refreshes only after the slow TTL", async () => {
    const { coordinator, collectSlowPart, advance } = buildCoordinator();
    coordinator.request();
    await coordinator.stop();

    // Doi richieste dopo el TTL: una sola CLI, el single-flight le unisse.
    advance(options.slowTtlMs + 1);
    coordinator.request();
    coordinator.request();
    expect(collectSlowPart).toHaveBeenCalledTimes(2);

    // Dentro el slow TTL: niente nova CLI.
    advance(1_000);
    coordinator.request();
    expect(collectSlowPart).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("marks the snapshot stale but keeps the last slow data when the CLI cycle fails", async () => {
    let failing = false;
    const { coordinator, advance } = buildCoordinator({
      collectSlowPart: async () => {
        if (failing) throw new Error("timeout");
        return slowPart;
      },
    });
    coordinator.request();
    await coordinator.stop();
    expect(coordinator.request().body).not.toMatchObject({ stale: true });

    failing = true;
    advance(options.slowTtlMs + 1);
    coordinator.request();
    await coordinator.stop();

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

  it("returns 503 only when no data at all is available", () => {
    const { coordinator } = buildCoordinator({
      getAgentIds: () => {
        throw new Error("config unavailable");
      },
      collectSlowPart: () => new Promise<SlowStatusPart>(() => undefined),
    });
    const payload = coordinator.request();
    expect(payload.status).toBe(503);
    expect(payload.body).toMatchObject({ ok: false, error: "status refresh failed" });
  });
});
