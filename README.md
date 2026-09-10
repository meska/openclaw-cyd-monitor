# OpenClaw CYD Monitor

A friendly OpenClaw status display for the **ESP32-2432S028R**, better known as
the 2.8-inch Cheap Yellow Display (CYD).

The firmware shows a tiny animated claw-bot alongside sanitized Gateway,
session, task, agent, heartbeat, queue, plugin, and device metrics. Touch the
named footer tabs to switch pages.

![OpenClaw CYD dashboard](docs/dashboard-preview.svg)

## Why a plugin bridge?

The ESP32 never receives an OpenClaw Gateway token and never reads transcripts.
The OpenClaw plugin collects local status, removes session keys, recipients,
hostnames, message content, and configuration, then serves only aggregate
counters on the LAN. It starts and stops with the Gateway, so no separate
Python environment or operating-system service is required.

```text
OpenClaw Gateway -> CYD Monitor plugin :8765 -> sanitized JSON -> ESP32 CYD
```

The public payload contains:

- Gateway online state and latency;
- sessions active in the last 15 minutes plus a rolling aggregate token-load graph;
- triage, running, blocked, and completed-in-24-hours counts from the default Workboard, excluding
  archived cards so the numbers match its visible columns;
- latest-session model name;
- OpenClaw version and degraded-plugin count.

Token load is the context-capacity-weighted percentage across sessions updated
in the last 15 minutes whose token counters are fresh. The display keeps 32
five-second samples (about 2 minutes 40 seconds). If the bridge becomes stale,
the last valid history stays visible in amber with a `LAST` label; a disconnected
display keeps it in gray. Fresh samples resume the graph without inventing zeroes.

## Hardware

- ESP32-2432S028R / CYD 2.8-inch display;
- ILI9341-compatible 320x240 TFT;
- XPT2046 resistive touch controller;
- Wi-Fi access to the machine running OpenClaw.

**[Buy the ESP32-2432S028R / CYD display on AliExpress](https://www.awin1.com/cread.php?awinmid=12251&awinaffid=3083039&ued=https%3A%2F%2Fwww.aliexpress.com%2Fitem%2F1005007401669955.html)**

> **Affiliate disclosure:** this is an affiliate link. If you purchase through
> it, the maintainer may receive a commission at no additional cost to you.

## Install the OpenClaw plugin

Requires OpenClaw 2026.9.3 or newer. Install the published ClawHub package:

```bash
openclaw plugins install clawhub:meska/openclaw-cyd-monitor
curl http://127.0.0.1:8765/api/status
```

For local development, build and install the exact package shape that ClawHub
will distribute:

```bash
npm install
npm test
npm run check
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/openclaw-cyd-monitor-0.2.0.tgz --force
```

The plugin listens on `0.0.0.0:8765` and refreshes every five seconds by
default. Override settings through `plugins.entries.openclaw-cyd-monitor.config`:

```json
{
  "host": "0.0.0.0",
  "port": 8765,
  "intervalMs": 5000,
  "timeoutMs": 10000,
  "activeMinutes": 15,
  "workboard": "default"
}
```

The endpoint intentionally contains no authentication token because its payload
is non-sensitive and aggregate-only. Keep port 8765 on your trusted LAN; do not
forward it from your router.

## Build the firmware

```bash
cd firmware
uvx --from platformio platformio run
uvx --from platformio platformio run --target upload --upload-port /dev/cu.usbserial-XXXX
```

On first boot, connect a phone or laptop to the `OpenClaw-CYD` Wi-Fi network.
The captive portal asks for Wi-Fi credentials and the bridge URL, such as
`http://192.168.1.20:8765`.

### Later updates over Wi-Fi

After the first USB flash, updates no longer require the BOOT button:

1. Open the device page on the display.
2. Hold the main panel for two seconds to open a two-minute OTA window.
3. Upload from the same LAN:

   ```bash
   cd firmware
   uvx --from platformio platformio run -e cyd-ota --target upload
   ```

The OTA service appears as `openclaw-cyd.local` only during the physically
activated window. An upload that starts inside the window is allowed to finish;
a failed transfer leaves the running firmware intact because the new image is
written to the alternate OTA partition.

If the display stays attached over a data-capable USB cable, PlatformIO can
also enter the bootloader through DTR/RTS and update it unattended. Use the
regular `cyd` upload command above; the physical BOOT button remains only a
recovery path.

## API example

```json
{
  "schema": 2,
  "ok": true,
  "collectedAtMs": 1788880000000,
  "gateway": { "online": true, "latencyMs": 42 },
  "sessions": { "total": 17, "recent": 3, "active": 2, "tokenLoadPercent": 31, "tokenSamples": 2, "model": "gpt-6" },
  "tasks": { "active": 2, "failures": 0 },
  "agents": { "total": 4, "heartbeatEnabled": 2 },
  "system": { "version": "2026.9.3", "queuedEvents": 0, "degradedPlugins": 0 },
  "workboard": { "triage": 2, "running": 1, "blocked": 0, "done24h": 7 }
}
```

## Privacy and release checklist

- Never commit flash dumps, Wi-Fi configuration, `.env` files, or device-local
  `device_config.h` files.
- Review `git diff --staged` and scan the entire branch before a public push.
- Use a GitHub noreply address for public commits.

## Visual direction

The dashboard screenshot above is a deterministic 320x240 rendering of the
firmware layout, using representative sanitized values from the public payload.
It can be regenerated from [`docs/dashboard-preview.svg`](docs/dashboard-preview.svg).

The original concept artwork in `docs/concept.png` was generated with OpenAI's
built-in image generation tool. The firmware mascot is a deterministic,
code-drawn interpretation designed for the CYD's limited memory and resolution.

Hardware layout and interaction ideas were informed by the MIT-licensed
[OhMyClawd](https://github.com/opariffazman/ohmyclawd) project. No Claude usage
credentials or daemon protocol are used here.

## License

[MIT](LICENSE)
