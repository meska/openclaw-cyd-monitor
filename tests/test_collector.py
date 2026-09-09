from openclaw_cyd_bridge.collector import snapshot_from_payload


def test_snapshot_is_aggregate_and_drops_identity_fields() -> None:
    payload = {
        "gateway": {"reachable": True, "connectLatencyMs": 42, "url": "secret-host"},
        "sessions": {
            "count": 17,
            "recent": [
                {
                    "key": "private-session-key",
                    "recipient": "private-recipient",
                    "model": "gpt-test",
                    "percentUsed": 31,
                }
            ],
        },
        "tasks": {"active": 2, "failures": 1},
        "agents": {"agents": [{"id": "main"}, {"id": "ops"}]},
        "heartbeat": {"agents": [{"enabled": True}, {"enabled": False}]},
        "runtimeVersion": "2026.9.3",
        "queuedSystemEvents": [{"private": "payload"}],
        "degradedPlugins": [],
    }

    workboard = {
        "cards": [
            {"status": "triage", "title": "private title"},
            {"status": "running", "notes": "private notes"},
            {"status": "blocked", "metadata": {"secret": "private metadata"}},
            {"status": "done"},
        ]
    }
    public = snapshot_from_payload(
        payload, now_ms=1234, active_sessions=3, workboard_payload=workboard
    ).to_dict()

    assert public["gateway"] == {"online": True, "latencyMs": 42}
    assert public["sessions"] == {
        "total": 17,
        "recent": 1,
        "active": 3,
        "model": "gpt-test",
    }
    assert public["agents"] == {"total": 2, "heartbeatEnabled": 1}
    assert public["workboard"] == {"triage": 1, "running": 1, "blocked": 1}
    serialized = str(public)
    assert "private-session-key" not in serialized
    assert "private-recipient" not in serialized
    assert "secret-host" not in serialized
    assert "private title" not in serialized
    assert "private notes" not in serialized
    assert "private metadata" not in serialized


def test_snapshot_tolerates_missing_and_wrong_types() -> None:
    public = snapshot_from_payload({"gateway": None, "sessions": []}, now_ms=7).to_dict()

    assert public["ok"] is False
    assert public["sessions"]["model"] == "unknown"
    assert public["sessions"]["active"] == 0
    assert public["tasks"] == {"active": 0, "failures": 0}
    assert public["workboard"] == {"triage": 0, "running": 0, "blocked": 0}
