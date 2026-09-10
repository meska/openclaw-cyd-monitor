import { afterEach, describe, expect, it, vi } from "vitest";

import { SnapshotCache } from "../src/server.js";
import type { Logger, StatusSnapshot } from "../src/types.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const snapshot: StatusSnapshot = {
  schema: 2,
  ok: true,
  collectedAtMs: 1,
  gateway: { online: true, latencyMs: 2 },
  sessions: { total: 1, recent: 1, active: 1, tokenLoadPercent: 10, tokenSamples: 1, model: "test" },
  tasks: { active: 0, failures: 0 },
  agents: { total: 1, heartbeatEnabled: 0 },
  system: { version: "test", queuedEvents: 0, degradedPlugins: 0 },
  workboard: { triage: 0, running: 0, blocked: 0, done24h: 0 },
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SnapshotCache", () => {
  it("keeps the last valid snapshot when a refresh fails", async () => {
    vi.useFakeTimers();
    const collector = {
      collect: vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("timeout")),
    };
    const cache = new SnapshotCache(collector, 1000, logger);

    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.payload()).toEqual({ body: snapshot, status: 200 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(cache.payload()).toEqual({
      body: { ...snapshot, stale: true, error: "status refresh failed" },
      status: 200,
    });
    expect(logger.warn).toHaveBeenCalledWith("Status refresh failed: timeout");
    await cache.stop();
  });
});
