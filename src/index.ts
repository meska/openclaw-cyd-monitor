import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import {
  SlowCycleCollector,
  agentsFromConfig,
  slowPartFromPayloads,
} from "./collector.js";
import { parsePluginOptions } from "./config.js";
import { MonitorServer, StatusCoordinator } from "./server.js";
import type { SessionRowSummary } from "./types.js";

function agentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey ?? "");
  return match?.[1];
}

export default definePluginEntry({
  id: "openclaw-cyd-monitor",
  name: "OpenClaw CYD Monitor",
  description: "Serves sanitized OpenClaw metrics to an ESP32 CYD display",
  register(api) {
    if (api.registrationMode !== "full" && api.registrationMode !== "discovery") return;

    const options = parsePluginOptions(api.pluginConfig);
    const slowCycle = new SlowCycleCollector(api.runtime.system.runCommandWithTimeout, options);
    const coordinator = new StatusCoordinator({
      options,
      logger: api.logger,
      // Letture in-process: zero subprocess, zero riaperture del DB.
      // El cast el xe solo de forma: la riga del store la ga sempre sessionKey + entry.
      listSessions: (params) =>
        (api.runtime.agent.session.listSessionEntries(params) ?? []) as SessionRowSummary[],
      getAgentIds: () =>
        agentsFromConfig(api.runtime.config.current() as { agents?: Record<string, unknown> }),
      collectSlowPart: async () => {
        const { status, workboard } = await slowCycle.collect();
        return slowPartFromPayloads(status, workboard);
      },
    });
    const server = new MonitorServer(options, coordinator, api.logger);

    let unsubscribeSessionsChanged: (() => void) | undefined;

    api.registerService({
      id: "openclaw-cyd-monitor-http",
      reload: {
        configPrefixes: ["plugins.entries.openclaw-cyd-monitor.config"],
      },
      async start(ctx) {
        coordinator.reset();
        // Push, no polling: ogni sessions.changed marca sporco solo l'agente
        // che è cambiato. Se el facade no ghe xe, el TTL fa da fallback.
        unsubscribeSessionsChanged = ctx.gatewayEvents?.onSessionsChanged((event) => {
          coordinator.markSessionsDirty(event.agentId ?? agentIdFromSessionKey(event.sessionKey));
        });
        try {
          await server.start();
        } catch (error) {
          await coordinator.stop();
          throw error;
        }
      },
      async stop() {
        unsubscribeSessionsChanged?.();
        unsubscribeSessionsChanged = undefined;
        await Promise.all([server.stop(), coordinator.stop()]);
      },
    });
  },
});
