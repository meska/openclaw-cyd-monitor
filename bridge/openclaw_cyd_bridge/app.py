"""Threaded, cached HTTP bridge for the OpenClaw CYD Monitor."""

from __future__ import annotations

import argparse
import json
import logging
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .collector import OpenClawCollector, StatusSnapshot

LOG = logging.getLogger("openclaw-cyd-bridge")


class SnapshotCache:
    """Refresh OpenClaw status off the HTTP request path."""

    def __init__(self, collector: OpenClawCollector, interval: float = 5.0) -> None:
        self.collector = collector
        self.interval = max(1.0, interval)
        self._snapshot: StatusSnapshot | None = None
        self._error: str | None = "warming up"
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="status-refresh", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=self.interval + 1.0)

    def payload(self) -> tuple[dict[str, Any], int]:
        with self._lock:
            if self._snapshot is None:
                return {"schema": 2, "ok": False, "error": self._error}, HTTPStatus.SERVICE_UNAVAILABLE
            payload = self._snapshot.to_dict()
            if self._error:
                payload["stale"] = True
                payload["error"] = self._error
            return payload, HTTPStatus.OK

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                snapshot = self.collector.collect()
            except Exception as exc:  # noqa: BLE001 - the cache must survive collector failures.
                LOG.warning("Status refresh failed: %s", exc)
                with self._lock:
                    self._error = str(exc)[:160]
            else:
                with self._lock:
                    self._snapshot = snapshot
                    self._error = None
            self._stop.wait(self.interval)


def make_handler(cache: SnapshotCache) -> type[BaseHTTPRequestHandler]:
    """Bind a cache instance to a request handler class."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "OpenClawCYDBridge/0.1"

        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name.
            if self.path == "/api/status":
                payload, status = cache.payload()
                self._send_json(payload, status)
                return
            if self.path == "/healthz":
                self._send_json({"ok": True}, HTTPStatus.OK)
                return
            self._send_json({"ok": False, "error": "not found"}, HTTPStatus.NOT_FOUND)

        def log_message(self, fmt: str, *args: Any) -> None:
            LOG.debug("%s - %s", self.client_address[0], fmt % args)

        def _send_json(self, payload: dict[str, Any], status: int) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve sanitized OpenClaw metrics to a CYD")
    parser.add_argument("--host", default="0.0.0.0", help="listen address")
    parser.add_argument("--port", default=8765, type=int, help="listen port")
    parser.add_argument("--interval", default=5.0, type=float, help="refresh interval in seconds")
    parser.add_argument("--openclaw", default="openclaw", help="OpenClaw executable")
    parser.add_argument("--verbose", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    cache = SnapshotCache(OpenClawCollector(args.openclaw), interval=args.interval)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(cache))
    cache.start()
    LOG.info("Serving sanitized status on http://%s:%d/api/status", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        cache.stop()


if __name__ == "__main__":
    main()
