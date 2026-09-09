"""Collect and sanitize OpenClaw status for a tiny LAN display."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class GatewayStatus:
    """Small, non-sensitive Gateway health summary."""

    online: bool
    latency_ms: int


@dataclass(frozen=True)
class SessionStatus:
    """Aggregate session data; keys and recipients are deliberately excluded."""

    total: int
    recent: int
    active: int
    model: str


@dataclass(frozen=True)
class TaskStatus:
    """Aggregate task counters."""

    active: int
    failures: int


@dataclass(frozen=True)
class AgentStatus:
    """Aggregate agent and heartbeat counters."""

    total: int
    heartbeat_enabled: int


@dataclass(frozen=True)
class SystemStatus:
    """Safe runtime metadata."""

    version: str
    queued_events: int
    degraded_plugins: int


@dataclass(frozen=True)
class WorkboardStatus:
    """Aggregate card states; titles and card metadata never leave the Mac."""

    triage: int
    running: int
    blocked: int


@dataclass(frozen=True)
class StatusSnapshot:
    """Wire format consumed by the ESP32 firmware."""

    schema: int
    ok: bool
    collected_at_ms: int
    gateway: GatewayStatus
    sessions: SessionStatus
    tasks: TaskStatus
    agents: AgentStatus
    system: SystemStatus
    workboard: WorkboardStatus

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-ready dictionary using firmware-friendly camelCase keys."""

        raw = asdict(self)
        return {
            "schema": raw["schema"],
            "ok": raw["ok"],
            "collectedAtMs": raw["collected_at_ms"],
            "gateway": {
                "online": raw["gateway"]["online"],
                "latencyMs": raw["gateway"]["latency_ms"],
            },
            "sessions": {
                "total": raw["sessions"]["total"],
                "recent": raw["sessions"]["recent"],
                "active": raw["sessions"]["active"],
                "model": raw["sessions"]["model"],
            },
            "tasks": raw["tasks"],
            "agents": {
                "total": raw["agents"]["total"],
                "heartbeatEnabled": raw["agents"]["heartbeat_enabled"],
            },
            "system": {
                "version": raw["system"]["version"],
                "queuedEvents": raw["system"]["queued_events"],
                "degradedPlugins": raw["system"]["degraded_plugins"],
            },
            "workboard": raw["workboard"],
        }


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return max(0, int(value))
    return 0


def snapshot_from_payload(
    payload: dict[str, Any],
    now_ms: int | None = None,
    active_sessions: int = 0,
    workboard_payload: dict[str, Any] | None = None,
) -> StatusSnapshot:
    """Convert the CLI payload while dropping all message and identity fields."""

    gateway = _as_dict(payload.get("gateway"))
    sessions = _as_dict(payload.get("sessions"))
    recent = [_as_dict(item) for item in _as_list(sessions.get("recent"))]
    newest = recent[0] if recent else {}
    tasks = _as_dict(payload.get("tasks"))
    agents = _as_dict(payload.get("agents"))
    agent_items = _as_list(agents.get("agents"))
    heartbeat = _as_dict(payload.get("heartbeat"))
    heartbeat_items = [_as_dict(item) for item in _as_list(heartbeat.get("agents"))]
    workboard_cards = [
        _as_dict(item) for item in _as_list(_as_dict(workboard_payload).get("cards"))
    ]

    def cards_with_status(expected: str) -> int:
        # Conta quel che mostra la board: le card archiviate no le xe piu' operative.
        return sum(
            item.get("status") == expected
            and not _as_dict(item.get("metadata")).get("archivedAt")
            for item in workboard_cards
        )

    model = newest.get("model") or newest.get("configuredModel") or "unknown"
    if not isinstance(model, str):
        model = "unknown"

    return StatusSnapshot(
        schema=2,
        ok=bool(gateway.get("reachable")),
        collected_at_ms=now_ms if now_ms is not None else int(time.time() * 1000),
        gateway=GatewayStatus(
            online=bool(gateway.get("reachable")),
            latency_ms=_as_int(gateway.get("connectLatencyMs")),
        ),
        sessions=SessionStatus(
            total=_as_int(sessions.get("count")),
            recent=len(recent),
            active=_as_int(active_sessions),
            model=model[:31],
        ),
        tasks=TaskStatus(
            active=_as_int(tasks.get("active")),
            failures=_as_int(tasks.get("failures")),
        ),
        agents=AgentStatus(
            total=len(agent_items),
            heartbeat_enabled=sum(bool(item.get("enabled")) for item in heartbeat_items),
        ),
        system=SystemStatus(
            version=str(payload.get("runtimeVersion") or "unknown")[:23],
            queued_events=len(_as_list(payload.get("queuedSystemEvents"))),
            degraded_plugins=len(_as_list(payload.get("degradedPlugins"))),
        ),
        workboard=WorkboardStatus(
            triage=cards_with_status("triage"),
            running=cards_with_status("running"),
            blocked=cards_with_status("blocked"),
        ),
    )


class OpenClawCollector:
    """Run the local OpenClaw CLI and return only a sanitized snapshot."""

    def __init__(self, executable: str = "openclaw", timeout: float = 10.0) -> None:
        self.executable = executable
        self.timeout = timeout

    def collect(self) -> StatusSnapshot:
        executable = shutil.which(self.executable)
        if executable is None:
            raise RuntimeError(f"OpenClaw executable not found: {self.executable}")

        def run_json(arguments: list[str]) -> dict[str, Any]:
            result = subprocess.run(
                [executable, *arguments],
                check=True,
                capture_output=True,
                text=True,
                timeout=self.timeout,
            )
            parsed = json.loads(result.stdout)
            if not isinstance(parsed, dict):
                raise RuntimeError(f"OpenClaw {' '.join(arguments)} returned a non-object payload")
            return parsed

        # Le tre letture xe indipendenti: in parallelo el display no aspetta la somma dei CLI.
        with ThreadPoolExecutor(max_workers=3) as executor:
            status_future = executor.submit(run_json, ["status", "--json"])
            active_future = executor.submit(
                run_json,
                ["sessions", "--all-agents", "--active", "15", "--limit", "all", "--json"],
            )
            workboard_future = executor.submit(
                run_json, ["workboard", "list", "--board", "default", "--json"]
            )
            payload = status_future.result()
            active_payload = active_future.result()
            workboard_payload = workboard_future.result()
        return snapshot_from_payload(
            payload,
            active_sessions=_as_int(active_payload.get("count")),
            workboard_payload=workboard_payload,
        )
