import { describe, expect, it, vi } from "vitest";

import {
  SlowCycleCollector,
  agentsFromConfig,
  listAllSessionRows,
  sessionStatusFromRows,
  slowPartFromPayloads,
} from "../src/collector.js";
import type { CommandRunner, PluginOptions, SessionRowSummary } from "../src/types.js";

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

const NOW = 100_000_000;

describe("agentsFromConfig", () => {
  it("always includes main and dedupes configured agents", () => {
    expect(agentsFromConfig({ agents: { main: {}, ops: {}, support: {} } })).toEqual([
      "main",
      "ops",
      "support",
    ]);
    expect(agentsFromConfig({})).toEqual(["main"]);
  });
});

describe("listAllSessionRows", () => {
  it("skips agents whose store cannot be read", () => {
    const listSessions = vi.fn((params?: { agentId?: string }) => {
      if (params?.agentId === "broken") throw new Error("no store");
      return [{ sessionKey: `${params?.agentId}:row`, entry: {} }];
    });
    const rows = listAllSessionRows(listSessions, ["main", "broken"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionKey).toBe("main:row");
  });
});

describe("sessionStatusFromRows", () => {
  const rows: SessionRowSummary[] = [
    {
      sessionKey: "a",
      entry: { updatedAt: NOW - 60_000, model: "gpt-test", totalTokensFresh: true, totalTokens: 40, contextTokens: 100 },
    },
    {
      sessionKey: "b",
      entry: { updatedAt: NOW - 120_000, model: "older-model", totalTokensFresh: true, totalTokens: 20, contextTokens: 100 },
    },
    {
      sessionKey: "c",
      entry: { updatedAt: NOW - 300_000, totalTokensFresh: false, totalTokens: 99, contextTokens: 100 },
    },
    {
      sessionKey: "d",
      entry: { updatedAt: NOW - 7_200_000 },
    },
    {
      sessionKey: "e",
      entry: { updatedAt: NOW - 90_000_000 },
    },
  ];

  it("counts windows, token load and newest active model without exposing identities", () => {
    expect(sessionStatusFromRows(rows, 15, NOW)).toEqual({
      total: 5,
      recent: 4,
      active: 3,
      tokenLoadPercent: 30,
      tokenSamples: 2,
      model: "gpt-test",
    });
  });

  it("degrades to zero load when token fields are absent", () => {
    const status = sessionStatusFromRows(
      [{ sessionKey: "a", entry: { updatedAt: NOW - 1_000, model: "m" } }],
      15,
      NOW,
    );
    expect(status.tokenLoadPercent).toBe(0);
    expect(status.tokenSamples).toBe(0);
    expect(status.model).toBe("m");
  });
});

describe("slowPartFromPayloads", () => {
  it("maps aggregates and workboard counts, dropping private fields", () => {
    const payload = {
      tasks: { active: 2, failures: 1 },
      agents: { agents: [{ id: "ignored" }] },
      cliProjection: { agents: { rows: [{ id: "main" }, { id: "ops" }] } },
      heartbeat: { agents: [{ enabled: true }, { enabled: false }] },
      runtimeVersion: "2026.9.7",
      queuedSystemEvents: [{ private: "payload" }, { private: "payload" }],
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

    expect(slowPartFromPayloads(payload, workboard, NOW)).toEqual({
      tasks: { active: 2, failures: 1 },
      agents: { total: 2, heartbeatEnabled: 1 },
      system: { version: "2026.9.7", queuedEvents: 2, degradedPlugins: 0 },
      workboard: { triage: 1, running: 1, blocked: 1, done24h: 1 },
    });
  });
});

describe("SlowCycleCollector", () => {
  function runnerWith(outputs: Array<{ stdout?: unknown; code?: number }>): {
    runner: CommandRunner;
    argvs: string[][];
  } {
    const argvs: string[][] = [];
    let index = 0;
    const runner: CommandRunner = async (argv) => {
      argvs.push(argv);
      const output = outputs[Math.min(index, outputs.length - 1)] ?? { stdout: {} };
      index += 1;
      return {
        stdout: JSON.stringify(output.stdout ?? {}),
        stderr: "",
        code: output.code ?? 0,
        termination: "exit",
      };
    };
    return { runner, argvs };
  }

  it("runs the status RPC first and the workboard query second, serially", async () => {
    const { runner, argvs } = runnerWith([
      { stdout: { runtimeVersion: "x", cliProjection: { agents: { rows: [{}] } } } },
      { stdout: { cards: [] } },
    ]);
    const collector = new SlowCycleCollector(runner, options);
    await collector.collect();
    expect(argvs[0]?.slice(1, 4)).toEqual(["gateway", "call", "status"]);
    expect(argvs[0]?.join(" ")).not.toContain("system-presence");
    expect(argvs[1]?.slice(1, 3)).toEqual(["workboard", "list"]);
  });

  it("falls back to four serial status queries when the global list is capped at 50", async () => {
    const { runner, argvs } = runnerWith([
      { stdout: { runtimeVersion: "x" } },
      { stdout: { cards: Array.from({ length: 50 }, (_, i) => ({ status: "running", id: i })) } },
      { stdout: { cards: [{ status: "triage" }] } },
      { stdout: { cards: [] } },
      { stdout: { cards: [] } },
      { stdout: { cards: [] } },
    ]);
    const collector = new SlowCycleCollector(runner, options);
    const { workboard } = await collector.collect();
    expect(argvs).toHaveLength(6);
    expect((workboard as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it("uses the configured board when workboard is not all", async () => {
    const { runner, argvs } = runnerWith([
      { stdout: { runtimeVersion: "x" } },
      { stdout: { cards: [] } },
    ]);
    const collector = new SlowCycleCollector(runner, { ...options, workboard: "support-tickets" });
    await collector.collect();
    expect(argvs[1]?.join(" ")).toContain("support-tickets");
  });

  it("propagates CLI failures with bounded detail", async () => {
    const runner: CommandRunner = async () => ({
      stdout: "",
      stderr: "boom-detail",
      code: 1,
      termination: "exit",
    });
    const collector = new SlowCycleCollector(runner, options);
    await expect(collector.collect()).rejects.toThrow("boom-detail");
  });
});
