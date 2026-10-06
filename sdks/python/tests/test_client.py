"""Tests for the Veriflow Python SDK.

Two layers:
- unit: a fake urlopen transport (no network) asserting request shapes,
  auth headers, error mapping, and env config;
- live: end-to-end against a running API when VERIFLOW_TEST_API_URL is set
  (the nightly CI job sets it; locally the tests skip).
"""

from __future__ import annotations

import io
import json
import os
import urllib.request

import pytest

from veriflow import Veriflow, VeriflowError


class FakeResponse:
    def __init__(self, payload: bytes, status: int = 200) -> None:
        self._buf = io.BytesIO(payload)
        self.status = status

    def read(self, *args: object) -> bytes:
        return self._buf.read()

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        pass


class FakeOpener:
    """Records requests; answers from a (method, path) -> payload table."""

    def __init__(self, routes: dict, status: int = 200) -> None:
        self.routes = routes
        self.status = status
        self.calls: list[tuple[str, str, bytes | None, dict]] = []

    def open(self, req: urllib.request.Request, timeout: float | None = None) -> FakeResponse:
        path = req.full_url.split("/", 3)[-1] if req.full_url.count("/") > 3 else req.full_url
        # keep the full path-after-host for routing
        from urllib.parse import urlsplit

        path = urlsplit(req.full_url).path
        body = req.data
        self.calls.append((req.get_method(), path, body, dict(req.header_items())))
        key = (req.get_method(), path)
        if key in self.routes:
            return FakeResponse(json.dumps(self.routes[key]).encode("utf-8"), self.status)
        return FakeResponse(b"{}", self.status)


def make_client(routes: dict) -> tuple[Veriflow, FakeOpener]:
    opener = FakeOpener(routes)
    return Veriflow(api_url="http://api.test", token="tok-123", opener=opener), opener


def test_health_and_auth_header() -> None:
    vf, opener = make_client({("GET", "/health"): {"ok": True, "version": "0.1.0"}})
    assert vf.health()["ok"] is True
    method, path, _, headers = opener.calls[0]
    assert (method, path) == ("GET", "/health")
    flat = {k.lower(): v for k, v in headers.items()}
    assert flat["authorization"] == "Bearer tok-123"
    assert "content-type" not in flat  # GET carries no body header


def test_create_run_shape_and_trace() -> None:
    vf, opener = make_client(
        {
            ("POST", "/v1/runs"): {"id": "run_1"},
            ("GET", "/v1/runs/run_1/trace"): {"run": {"status": "passed"}, "steps": [1, 2], "spans": []},
        }
    )
    run = vf.create_run("open example.com", env_url="https://example.com", status="queued")
    assert run == {"id": "run_1"}
    method, path, body, _ = opener.calls[0]
    assert method == "POST" and path == "/v1/runs"
    sent = json.loads(body)
    assert sent["objective"] == "open example.com"
    assert sent["envUrl"] == "https://example.com"
    assert sent["status"] == "queued"

    trace = vf.trace("run_1")
    assert trace["run"]["status"] == "passed" and len(trace["steps"]) == 2


def test_worker_sync_reuses_run_id() -> None:
    vf, opener = make_client({("POST", "/v1/runs"): {"id": "run_9"}})
    vf.create_run("obj", run_id="run_9", status="passed", step_count=3, events=[{"type": "run_end", "ts": "t", "payload": {}}])
    sent = json.loads(opener.calls[0][2])
    assert sent["id"] == "run_9" and sent["status"] == "passed" and sent["stepCount"] == 3
    assert sent["events"][0]["type"] == "run_end"


def test_error_mapping() -> None:
    class ErrOpener:
        def open(self, req: urllib.request.Request, timeout: float | None = None) -> FakeResponse:
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, io.BytesIO(b'{"error":"not found"}'))

    vf = Veriflow(api_url="http://api.test", token="t", opener=ErrOpener())
    with pytest.raises(VeriflowError) as excinfo:
        vf.get_run("nope")
    assert excinfo.value.status == 404
    assert excinfo.value.code == "not found"


def test_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VERIFLOW_API_URL", "https://cloud.test")
    monkeypatch.setenv("VERIFLOW_API_KEY", "vf-key-1")
    vf = Veriflow.from_env()
    assert vf.api_url == "https://cloud.test" and vf.token == "vf-key-1"
    monkeypatch.delenv("VERIFLOW_API_KEY")
    monkeypatch.setenv("VERIFLOW_TOKEN", "sess-2")
    assert Veriflow.from_env().token == "sess-2"


# ---- live smoke (nightly CI sets VERIFLOW_TEST_API_URL; skipped locally) ----

LIVE = os.environ.get("VERIFLOW_TEST_API_URL")


@pytest.mark.skipif(not LIVE, reason="VERIFLOW_TEST_API_URL not set")
def test_live_round_trip() -> None:
    vf = Veriflow(api_url=LIVE, timeout=15)
    assert vf.health()["ok"] is True
    email = f"py-sdk-{os.getpid()}@example.com"
    token = vf.signup(email, "password1")["token"]
    authed = Veriflow(api_url=LIVE, token=token)
    me = authed.me()
    assert me["user"]["email"] == email
    run = authed.create_run("py-sdk live run", env_url="https://example.com", status="queued")
    got = authed.get_run(run["id"])
    assert got["run"]["id"] == run["id"]
    # sync a passing result under the same id, then read the trace
    now = "2026-01-01T00:00:00.000Z"
    authed.create_run(
        "py-sdk live run",
        run_id=run["id"],
        status="passed",
        step_count=2,
        started_at=now,
        ended_at=now,
        events=[
            {"type": "run_start", "ts": now, "payload": {"objective": "py-sdk live run"}},
            {"type": "decide", "ts": now, "stepIndex": 0, "payload": {"action": {"type": "finish", "success": True, "reason": "ok"}}},
            {"type": "run_end", "ts": now, "payload": {"status": "passed"}},
        ],
    )
    trace = authed.trace(run["id"])
    assert trace["run"]["status"] == "passed"
