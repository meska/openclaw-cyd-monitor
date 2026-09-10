import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { OpenClawCollector } from "./collector.js";
import { parsePluginOptions } from "./config.js";
import { MonitorServer, SnapshotCache } from "./server.js";

export default definePluginEntry({
  id: "openclaw-cyd-monitor",
  name: "OpenClaw CYD Monitor",
  description: "Serves sanitized OpenClaw metrics to an ESP32 CYD display",
  register(api) {
    if (api.registrationMode !== "full" && api.registrationMode !== "discovery") return;

    const options = parsePluginOptions(api.pluginConfig);
    const collector = new OpenClawCollector(api.runtime.system.runCommandWithTimeout, options);
    const cache = new SnapshotCache(collector, options.intervalMs, api.logger);
    const server = new MonitorServer(options, cache, api.logger);

    api.registerService({
      id: "openclaw-cyd-monitor-http",
      reload: {
        configPrefixes: ["plugins.entries.openclaw-cyd-monitor.config"],
      },
      async start() {
        cache.start();
        try {
          await server.start();
        } catch (error) {
          await cache.stop();
          throw error;
        }
      },
      async stop() {
        await Promise.all([server.stop(), cache.stop()]);
      },
    });
  },
});
