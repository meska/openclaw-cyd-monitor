import type { PluginOptions } from "./types.js";

const defaults: PluginOptions = {
  host: "0.0.0.0",
  port: 8765,
  intervalMs: 5000,
  timeoutMs: 10000,
  activeMinutes: 15,
  workboard: "default",
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
    intervalMs: boundedInteger(config?.intervalMs, defaults.intervalMs, 1000, 60000),
    timeoutMs: boundedInteger(config?.timeoutMs, defaults.timeoutMs, 1000, 60000),
    activeMinutes: boundedInteger(config?.activeMinutes, defaults.activeMinutes, 1, 1440),
    workboard: nonEmptyString(config?.workboard, defaults.workboard),
    executable: nonEmptyString(config?.executable, defaults.executable),
  };
}
