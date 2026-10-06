# veriflow (Python)

Official Python client for the [Veriflow](https://github.com/jjssmyhaks-dev/auto_test) cloud API. Zero dependencies — stdlib (`urllib`) only, Python 3.9+.

```bash
pip install veriflow   # published package name; from source: pip install ./sdks/python
```

## Quickstart

```python
from veriflow import Veriflow

vf = Veriflow.from_env()  # VERIFLOW_API_URL + VERIFLOW_API_KEY (or VERIFLOW_TOKEN)
print(vf.health())

# Submit a run and read the result
run = vf.create_run("open example.com and assert the heading",
                    env_url="https://example.com", status="queued")
trace = vf.trace(run["id"])
print(trace["run"]["status"], len(trace["steps"]), "steps")
```

Or with explicit credentials (signup returns a session token):

```python
vf = Veriflow(api_url="http://127.0.0.1:8787")
token = vf.signup("me@example.com", "password1")["token"]
authed = Veriflow(api_url="http://127.0.0.1:8787", token=token)
print(authed.me())
```

## Submitting results (workers)

A worker syncs a finished result under the *same* run id — the cloud updates
the row in place (`queued → running → passed/failed`):

```python
authed.create_run("open example.com and assert the heading",
                  run_id=run["id"], status="passed", step_count=2,
                  events=[...])  # the event log powers steps, healing, diffs
```

## Device cloud (keyless recipes)

```python
job = authed.create_device_job("nightly recipe", flow_id=flow_id, mode="recipe")
jobs = authed.list_device_jobs()
```

## API surface

| Method | Endpoint |
| --- | --- |
| `health()` | `GET /health` |
| `signup(email, password)` / `login(email, password)` | `POST /v1/auth/*` |
| `me()` | `GET /v1/me` |
| `list_flows()` / `save_flow(name, objective)` | `/v1/flows` |
| `flow_recipe(flow_id)` | `GET /v1/flows/:id/recipe` |
| `create_run(...)` / `get_run(id)` / `list_runs(limit)` | `/v1/runs` |
| `trace(id)` | `GET /v1/runs/:id/trace` |
| `create_device_job(...)` / `list_device_jobs()` | `/v1/device-jobs` |
| `usage()` | `GET /v1/usage` |

Errors raise `VeriflowError(status, code, message)`.

## Tests

```bash
cd sdks/python
pip install -e ".[dev]"
pytest -q                                   # unit tests (fake transport)
VERIFLOW_TEST_API_URL=http://127.0.0.1:8787 pytest -q   # + live round-trip
```
