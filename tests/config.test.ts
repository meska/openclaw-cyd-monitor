import { describe, expect, it } from "vitest";

import { parsePluginOptions } from "../src/config.js";

describe("parsePluginOptions", () => {
  it("provides safe defaults", () => {
    expect(parsePluginOptions(undefined)).toEqual({
      host: "0.0.0.0",
      port: 8765,
      intervalMs: 5000,
      timeoutMs: 10000,
      activeMinutes: 15,
      workboard: "default",
      executable: "openclaw",
    });
  });

  it("rejects invalid values without widening the listener", () => {
    expect(parsePluginOptions({ host: " ", port: 70000, intervalMs: 2 })).toMatchObject({
      host: "0.0.0.0",
      port: 8765,
      intervalMs: 5000,
    });
  });
});
