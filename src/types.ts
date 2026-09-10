export interface GatewayStatus {
  online: boolean;
  latencyMs: number;
}

export interface SessionStatus {
  total: number;
  recent: number;
  active: number;
  tokenLoadPercent: number;
  tokenSamples: number;
  model: string;
}

export interface TaskStatus {
  active: number;
  failures: number;
}

export interface AgentStatus {
  total: number;
  heartbeatEnabled: number;
}

export interface SystemStatus {
  version: string;
  queuedEvents: number;
  degradedPlugins: number;
}

export interface WorkboardStatus {
  triage: number;
  running: number;
  blocked: number;
  done24h: number;
}

export interface StatusSnapshot {
  schema: 2;
  ok: boolean;
  collectedAtMs: number;
  gateway: GatewayStatus;
  sessions: SessionStatus;
  tasks: TaskStatus;
  agents: AgentStatus;
  system: SystemStatus;
  workboard: WorkboardStatus;
  stale?: boolean;
  error?: string;
}

export interface PluginOptions {
  host: string;
  port: number;
  intervalMs: number;
  timeoutMs: number;
  activeMinutes: number;
  workboard: string;
  executable: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
}

export type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number; maxOutputBytes: number },
) => Promise<CommandResult>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}
