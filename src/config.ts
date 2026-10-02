import type { PluginOptions } from "./types.js";

const defaults: PluginOptions = {
  host: "0.0.0.0",
  port: 8765,
  fastTtlMs: 30_000,
  slowTtlMs: 60_000,
  timeoutMs: 60_000,
  activeMinutes: 15,
  workboard: "all",
  executable: "openclaw",
};

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function parsePluginOptions(config: Record<string, unknown> | undefined): PluginOptions {
  return {
    host: nonEmptyString(config?.host, defaults.host),
    port: boundedInteger(config?.port, defaults.port, 1, 65535),
    fastTtlMs: boundedInteger(config?.fastTtlMs, defaults.fastTtlMs, 1_000, 600_000),
    slowTtlMs: boundedInteger(config?.slowTtlMs, defaults.slowTtlMs, 15_000, 3_600_000),
    timeoutMs: boundedInteger(config?.timeoutMs, defaults.timeoutMs, 1_000, 60_000),
    activeMinutes: boundedInteger(config?.activeMinutes, defaults.activeMinutes, 1, 1440),
    workboard: nonEmptyString(config?.workboard, defaults.workboard),
    executable: nonEmptyString(config?.executable, defaults.executable),
  };
}
