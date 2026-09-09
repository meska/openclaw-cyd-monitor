# OpenClaw CYD Monitor

A friendly OpenClaw status display for the **ESP32-2432S028R**, better known as
the 2.8-inch Cheap Yellow Display (CYD).

The firmware shows a tiny animated claw-bot alongside sanitized Gateway,
session, task, agent, heartbeat, queue, plugin, and device metrics. Touch the
named footer tabs to switch pages.

![OpenClaw CYD visual direction](docs/concept.png)

## Why a bridge?

The ESP32 never receives an OpenClaw Gateway token and never reads transcripts.
A tiny local Python process runs `openclaw status --json`, removes session keys,
recipients, hostnames, message content, and configuration, then serves only
aggregate counters on the LAN.

```text
OpenClaw CLI -> local bridge :8765 -> sanitized JSON -> ESP32 CYD
```

The public payload contains:

- Gateway online state and latency;
- sessions active in the last 15 minutes plus aggregate task, agent, and heartbeat counts;
- aggregate Workboard triage, running, and blocked card counts;
- latest-session model name;
- OpenClaw version and degraded-plugin count.

## Hardware

- ESP32-2432S028R / CYD 2.8-inch display;
- ILI9341-compatible 320x240 TFT;
- XPT2046 resistive touch controller;
- Wi-Fi access to the machine running OpenClaw.

## Run the bridge

Requires Python 3.11+, Poetry, and a working `openclaw` CLI.

```bash
poetry install
poetry run openclaw-cyd-bridge --host 0.0.0.0 --port 8765
curl http://127.0.0.1:8765/api/status
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
  "sessions": { "total": 17, "recent": 3, "active": 2, "model": "gpt-6" },
  "tasks": { "active": 2, "failures": 0 },
  "agents": { "total": 4, "heartbeatEnabled": 2 },
  "system": { "version": "2026.9.3", "queuedEvents": 0, "degradedPlugins": 0 },
  "workboard": { "triage": 2, "running": 1, "blocked": 0 }
}
```

## Privacy and release checklist

- Never commit flash dumps, Wi-Fi configuration, `.env` files, or device-local
  `device_config.h` files.
- Review `git diff --staged` and scan the entire branch before a public push.
- Use a GitHub noreply address for public commits.

## Visual direction

The original concept artwork in `docs/concept.png` was generated with OpenAI's
built-in image generation tool. The firmware mascot is a deterministic,
code-drawn interpretation designed for the CYD's limited memory and resolution.

Hardware layout and interaction ideas were informed by the MIT-licensed
[OhMyClawd](https://github.com/opariffazman/ohmyclawd) project. No Claude usage
credentials or daemon protocol are used here.

## License

[MIT](LICENSE)
