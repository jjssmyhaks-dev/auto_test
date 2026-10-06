"""Veriflow API client — stdlib only (urllib), Python 3.9+, zero dependencies.

Mirrors the official TypeScript SDK (@veriflow/sdk): signup/login/session
tokens or project API keys, run submission with result ingestion, trace
reading, flows, and device jobs.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

__all__ = ["Veriflow", "VeriflowError", "Run", "Trace"]

Run = Dict[str, Any]
Trace = Dict[str, Any]

DEFAULT_API_URL = "http://127.0.0.1:8787"


class VeriflowError(Exception):
    """Raised on non-2xx API responses (mirrors @veriflow/sdk VeriflowError)."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class Veriflow:
    def __init__(
        self,
        api_url: str = DEFAULT_API_URL,
        token: Optional[str] = None,
        timeout: float = 30.0,
        opener: Optional[Any] = None,
    ) -> None:
        self.api_url = api_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.opener = opener  # injectable urlopen for tests (or custom SSL)

    @classmethod
    def from_env(cls, **kwargs: Any) -> "Veriflow":
        """Build from VERIFLOW_API_URL + VERIFLOW_API_KEY (or VERIFLOW_TOKEN)."""
        return cls(
            api_url=os.environ.get("VERIFLOW_API_URL", DEFAULT_API_URL),
            token=os.environ.get("VERIFLOW_API_KEY") or os.environ.get("VERIFLOW_TOKEN"),
            **kwargs,
        )

    # ---- low-level request ----
    def request(self, method: str, path: str, body: Optional[Any] = None) -> Any:
        url = f"{self.api_url}{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"accept": "application/json"}
        if data is not None:
            headers["content-type"] = "application/json"
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        urlopen = self.opener.open if self.opener is not None else urllib.request.urlopen
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw) if raw else {}
            except ValueError:
                payload = {"error": raw}
            raise VeriflowError(
                err.code,
                str(payload.get("error") or payload.get("message") or err.reason),
                str(payload.get("error") or f"API {method} {path} failed ({err.code})"),
            ) from err

    # ---- auth ----
    def signup(self, email: str, password: str) -> Dict[str, Any]:
        return self.request("POST", "/v1/auth/signup", {"email": email, "password": password})

    def login(self, email: str, password: str) -> Dict[str, Any]:
        return self.request("POST", "/v1/auth/login", {"email": email, "password": password})

    def me(self) -> Dict[str, Any]:
        return self.request("GET", "/v1/me")

    # ---- health ----
    def health(self) -> Dict[str, Any]:
        return self.request("GET", "/health")

    # ---- flows ----
    def list_flows(self) -> List[Run]:
        return self.request("GET", "/v1/flows").get("flows", [])

    def save_flow(self, name: str, objective: str, **extra: Any) -> Dict[str, Any]:
        return self.request("POST", "/v1/flows", {"name": name, "objective": objective, **extra})

    def flow_recipe(self, flow_id: str) -> Dict[str, Any]:
        """The deterministic no-LLM action list derived from the newest passing run."""
        return self.request("GET", f"/v1/flows/{flow_id}/recipe")

    # ---- runs ----
    def create_run(
        self,
        objective: str,
        env_url: Optional[str] = None,
        status: str = "queued",
        *,
        flow_id: Optional[str] = None,
        run_id: Optional[str] = None,
        step_count: int = 0,
        browser: Optional[str] = None,
        error: Optional[str] = None,
        started_at: Optional[str] = None,
        ended_at: Optional[str] = None,
        events: Optional[List[Dict[str, Any]]] = None,
    ) -> Run:
        """Submit a run. Workers sync results with the same call: pass
        ``run_id`` (from a claimed job) plus ``events`` and the cloud updates
        the run row in place. ``status="queued"`` parks the run in the device
        queue for a worker to claim."""
        body: Dict[str, Any] = {"objective": objective, "status": status, "stepCount": step_count}
        if env_url is not None:
            body["envUrl"] = env_url
        if flow_id is not None:
            body["flowId"] = flow_id
        if run_id is not None:
            body["id"] = run_id
        if browser is not None:
            body["browser"] = browser
        if error is not None:
            body["error"] = error
        if started_at is not None:
            body["startedAt"] = started_at
        if ended_at is not None:
            body["endedAt"] = ended_at
        if events is not None:
            body["events"] = events
        return self.request("POST", "/v1/runs", body)

    def get_run(self, run_id: str) -> Dict[str, Any]:
        return self.request("GET", f"/v1/runs/{run_id}")

    def list_runs(self, limit: int = 50) -> List[Run]:
        return self.request("GET", f"/v1/runs?limit={limit}").get("runs", [])

    def trace(self, run_id: str) -> Trace:
        """Full result: run row + derived steps + spans + screenshot keys."""
        return self.request("GET", f"/v1/runs/{run_id}/trace")

    # ---- device cloud ----
    def create_device_job(self, objective: str, *, flow_id: Optional[str] = None, mode: str = "agent") -> Dict[str, Any]:
        """Queue work. ``mode="recipe"`` executes keylessly on the worker."""
        body: Dict[str, Any] = {"objective": objective, "mode": mode}
        if flow_id is not None:
            body["flowId"] = flow_id
        return self.request("POST", "/v1/device-jobs", body)

    def list_device_jobs(self) -> List[Dict[str, Any]]:
        return self.request("GET", "/v1/device-jobs").get("jobs", [])

    # ---- billing ----
    def usage(self) -> Dict[str, Any]:
        return self.request("GET", "/v1/usage")
