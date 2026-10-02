import { describe, expect, it } from "vitest";

import { parsePluginOptions } from "../src/config.js";

describe("parsePluginOptions", () => {
  it("provides safe on-demand defaults", () => {
    expect(parsePluginOptions(undefined)).toEqual({
      host: "0.0.0.0",
      port: 8765,
      fastTtlMs: 15_000,
      slowTtlMs: 60_000,
      timeoutMs: 60_000,
      activeMinutes: 15,
      workboard: "all",
      executable: "openclaw",
    });
  });

  it("rejects invalid values without widening the listener", () => {
    expect(parsePluginOptions({ host: " ", port: 70000, fastTtlMs: 2, slowTtlMs: 10 })).toMatchObject({
      host: "0.0.0.0",
      port: 8765,
      fastTtlMs: 15_000,
      slowTtlMs: 60_000,
    });
  });

  it("ignores the legacy intervalMs key without breaking", () => {
    expect(parsePluginOptions({ intervalMs: 5_000 })).toEqual(parsePluginOptions(undefined));
  });
});
