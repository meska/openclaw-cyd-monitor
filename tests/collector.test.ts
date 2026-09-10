import { describe, expect, it } from "vitest";

import { OpenClawCollector, snapshotFromPayload } from "../src/collector.js";
import type { CommandRunner, PluginOptions } from "../src/types.js";

describe("snapshotFromPayload", () => {
  it("returns aggregates and drops identity fields", () => {
    const payload = {
      gateway: { reachable: true, connectLatencyMs: 42, url: "secret-host" },
      sessions: {
        count: 17,
        recent: [
          {
            key: "private-session-key",
            recipient: "private-recipient",
            model: "gpt-test",
          },
        ],
      },
      tasks: { active: 2, failures: 1 },
      agents: { agents: [{ id: "main" }, { id: "ops" }] },
      heartbeat: { agents: [{ enabled: true }, { enabled: false }] },
      runtimeVersion: "2026.9.3",
      queuedSystemEvents: [{ private: "payload" }],
      degradedPlugins: [],
    };
    const workboard = {
      cards: [
        { status: "triage", title: "private title" },
        { status: "running", notes: "private notes" },
        { status: "blocked", metadata: { secret: "private metadata" } },
        { status: "blocked", metadata: { archivedAt: 1234 } },
        { status: "done", completedAt: 99_999_000 },
        { status: "done", completedAt: 99_998_000, metadata: { archivedAt: 99_999_500 } },
        { status: "done", completedAt: 13_599_999 },
      ],
    };

    const publicPayload = snapshotFromPayload(
      payload,
      {
        count: 3,
        sessions: [
          { totalTokensFresh: true, totalTokens: 40, contextTokens: 100 },
          { totalTokensFresh: true, totalTokens: 20, contextTokens: 100 },
          { totalTokensFresh: false, totalTokens: 99, contextTokens: 100 },
        ],
      },
      workboard,
      100_000_000,
    );

    expect(publicPayload.gateway).toEqual({ online: true, latencyMs: 42 });
    expect(publicPayload.sessions).toEqual({
      total: 17,
      recent: 1,
      active: 3,
      tokenLoadPercent: 30,
      tokenSamples: 2,
      model: "gpt-test",
    });
    expect(publicPayload.agents).toEqual({ total: 2, heartbeatEnabled: 1 });
    expect(publicPayload.workboard).toEqual({ triage: 1, running: 1, blocked: 1, done24h: 1 });
    const serialized = JSON.stringify(publicPayload);
    expect(serialized).not.toContain("private-session-key");
    expect(serialized).not.toContain("private-recipient");
    expect(serialized).not.toContain("secret-host");
    expect(serialized).not.toContain("private title");
    expect(serialized).not.toContain("private notes");
    expect(serialized).not.toContain("private metadata");
  });

  it("tolerates missing and wrong types", () => {
    const publicPayload = snapshotFromPayload({ gateway: null, sessions: [] }, {}, {}, 7);

    expect(publicPayload.ok).toBe(false);
    expect(publicPayload.sessions).toMatchObject({
      model: "unknown",
      active: 0,
      tokenLoadPercent: 0,
      tokenSamples: 0,
    });
    expect(publicPayload.tasks).toEqual({ active: 0, failures: 0 });
    expect(publicPayload.workboard).toEqual({ triage: 0, running: 0, blocked: 0, done24h: 0 });
  });

  it("keeps working when the optional Workboard plugin is absent", async () => {
    const options: PluginOptions = {
      host: "127.0.0.1",
      port: 8765,
      intervalMs: 5000,
      timeoutMs: 10000,
      activeMinutes: 15,
      workboard: "default",
      executable: "openclaw",
    };
    const runCommand: CommandRunner = async (argv) => {
      if (argv.includes("workboard")) throw new Error("workboard plugin missing");
      const body = argv.includes("sessions")
        ? { count: 0, sessions: [] }
        : { gateway: { reachable: true }, sessions: { count: 0, recent: [] } };
      return {
        stdout: JSON.stringify(body),
        stderr: "",
        code: 0,
        termination: "exit",
      };
    };

    const result = await new OpenClawCollector(runCommand, options).collect();

    expect(result.ok).toBe(true);
    expect(result.workboard).toEqual({ triage: 0, running: 0, blocked: 0, done24h: 0 });
  });
});
