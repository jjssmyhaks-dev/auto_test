# Veriflow

Local-first **vision browser testing**. The CLI (`veriflow`) drives Chromium with Playwright, asks a vision LLM for the next constrained action, enforces guardrails, redacts secrets, and writes a local evidence pack. Cloud API, dashboard, MCP, Playwright interop, chat agent-tests, and billing quotas are implemented for local use.

> 📄 **Reports**: [Product report & user guide](docs/product-report.md) — what Veriflow does and how to use it · [Engineering report](docs/engineering-report.md) — architecture, data model, conventions, and roadmap for the build team.

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io) 9+
- An LLM key for **browser** `veriflow run` (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Local `run` still works with **no Veriflow account**.
- Optional Docker for Postgres + MinIO.

## Install

```bash
pnpm install
pnpm build
pnpm playwright:install
```

## Local-only first run (no account)

```bash
# Windows PowerShell
$env:ANTHROPIC_API_KEY="..."

pnpm --filter @veriflow/cli start -- run "open https://example.com and assert the heading contains Example" --headless --env https://example.com
```

Headless exits `0` on pass and `1` on fail. Add `--devtools` for CDP network/console/performance capture. Add `--otlp` to write `otlp.json` (OTel-shaped JSON; not a live OTLP collector). Add `--sync` after `veriflow login` to push evidence to the API.

## Cloud stack (M2)

**Option A — docker-compose (Postgres + MinIO):**

```bash
docker compose up -d
# copy .env.example values into the API process environment
$env:DATABASE_URL="postgres://veriflow:veriflow@127.0.0.1:5432/veriflow"
$env:S3_ENDPOINT="http://127.0.0.1:9000"
$env:S3_ACCESS_KEY="veriflow"
$env:S3_SECRET_KEY="veriflowsecret"
$env:S3_BUCKET="veriflow"
pnpm --filter @veriflow/api start
```

**Option B — fallback (no Docker):** omit `DATABASE_URL` and `S3_*`. The API stores metadata in `~/.veriflow/cloud-data` (or `VERIFLOW_CLOUD_DIR`) and blobs on the filesystem (`VERIFLOW_BLOBS_DIR` or `.veriflow-data/blobs`). If Postgres is set but unreachable, the API logs a warning and uses the filesystem store.

### API

```bash
pnpm --filter @veriflow/api start   # :8787
```

- `POST /v1/auth/signup` / `login`
- Project-scoped API keys (`x-api-key`)
- Persist runs, steps, spans; upload evidence blobs
- Usage ledger + Free/Starter/Team quotas on **cloud** ingest
- Simulated `POST /v1/billing/upgrade` (no live Stripe unless you add keys later)
- `GET /v1/alerts` — `cost_spike` / `success_rate`; dashboard `/alerts`
- Alert **rules** (`/v1/alerts/rules` CRUD) with threshold evaluation, last-fired tracking, and webhook delivery
- `GET /v1/runs?status=&flowId=&limit=` — filtered run history for regression triage
- `GET /v1/runs/:id/otlp` — OTel-shaped JSON export for any synced run (pipe into Datadog/Honeycomb)
- Human-in-the-loop **pauses** (`/v1/human-pauses`) — magic-link lifecycle for CI: create / list / get / resolve, expiry, 409 on double-resolve
- `POST /v1/agent-tests` — runs a chat-agent eval server-side and ingests it as a first-class run
- **Metric rollups** (`POST /v1/metrics/rollups/refresh`, `GET /v1/metrics/rollups?flowId=`) — per-flow 7/30-day success, self-heal, intervention, cost, so the dashboard never scans raw spans on load
- Per-user UI **progress** (`GET/PUT/DELETE /v1/progress`) — onboarding checklist + tour position follow the account across devices (append-only union for ticks)
- `GET /v1/onboarding/funnel` — activation drop-off across accounts (rendered on `/usage`; **team tier only**, 403 otherwise)
- `POST /v1/demo-reset` — **team tier only**: wipes the project's runs (with steps/spans/evidence blobs), flows, alert rules, and usage ledger so the dashboard replays from scratch (Settings → Reset demo data)

### Dashboard

```bash
$env:NEXT_PUBLIC_API_URL="http://127.0.0.1:8787"
pnpm --filter @veriflow/web dev     # :3000
```

Usable pages: sign up/login, **queue an NL objective** on `/runs` (cloud record; harness still runs on CLI), run evidence/trace (`/evidence` and `/runs/:id` — AI Elements conversation, reasoning, chain-of-thought timeline, tool/action cards, plus the **trace scrubber** with a filmstrip of all step screenshots), **flows** (`/flows` — save, list, re-run, 30-day reliability rollups), **agent tests** (`/agent-test` — transcripts and a run form against `POST /v1/agent-tests`), project API keys, usage/upgrade with the **activation funnel**, **alerts** with rule CRUD, docs (`/docs/cli`, `/docs/mcp`), and **settings**.

The dashboard uses **Vercel AI Elements** (`npx ai-elements@latest` / source under `apps/web/components/ai-elements`). Peers: `ai`, `@ai-sdk/react`, Tailwind 4, shadcn/ui. No live LLM is required to render traces or sample eval chats.

### In-app onboarding

- **Guided tour** — a 9-step spotlight tour across the real userflow (queue → history → scrubber → flows → evidence → agent tests → usage → MCP → docs), in *Guided* or interactive **Try-it** mode where each step waits for the actual action (type an objective, open a run, scrub the timeline) before advancing. Resumable: Escape/backdrop pauses and any returning load continues at the saved step; a header button replays it any time.
- **Per-page `?` hints** — a mini tooltip on every dashboard page explaining that page's workflow and its CLI companion command.
- **Getting-started checklist** — four key actions (queue a run, scrub a trace, save a flow, create an alert rule) ticked by the real handlers, not page visits. At 4/4 the card becomes a completion state linking to the CLI/MCP docs, where a one-time prompt offers a Try-it replay.
- Progress **syncs to the account** via `/v1/progress` (localStorage is only the cache), so it follows the user across devices; **Settings → Reset onboarding** clears both the local cache and the server row; `/usage` shows the per-action activation funnel.

### CLI auth + sync

```bash
pnpm --filter @veriflow/cli start -- login --signup --email you@local.test --password password1 --api-url http://127.0.0.1:8787
pnpm --filter @veriflow/cli start -- profiles set --name demo --env https://example.com
pnpm --filter @veriflow/cli start -- run "…" --headless --env https://example.com --sync --otlp --devtools
```

Credentials are AES-256-GCM encrypted in `~/.veriflow/credentials.enc`.

### MCP

```bash
pnpm --filter @veriflow/mcp start           # HTTP :3333
pnpm --filter @veriflow/mcp start -- --stdio
```

Tools: `run_flow`, `get_run`, `export_playwright`, `list_flows`, `list_runs`, `get_trace`. Auth for API fallback: `VERIFLOW_API_KEY`. Cursor example: `.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "veriflow": {
      "command": "pnpm",
      "args": ["--filter", "@veriflow/mcp", "start", "--", "--stdio"],
      "env": {
        "VERIFLOW_API_KEY": "vf_…",
        "VERIFLOW_API_URL": "http://127.0.0.1:8787"
      }
    }
  }
}
```

## CLI

| Command | Behavior |
| --- | --- |
| `veriflow run "<objective>" [--headless] [--env] [--profile] [--devtools] [--otlp] [--sync] [--agent] [--pause-endpoint <url>] [--yes-i-mean-it] [--dry-run]` | Harness; `--pause-endpoint` waits on a human pause (e.g. OTP in CI) instead of hard-failing |
| `veriflow replay <run-id>` | Local event log playback (no browser, no LLM) |
| `veriflow replay <run-id> --live` | Deterministic re-execution of the recorded actions in a real browser — regression-check a passing flow without re-paying for LLM decisions |
| `veriflow login --email --password [--signup] [--api-url]` | Encrypted credentials |
| `veriflow profiles [list\|set --name --env]` | Named env URLs |
| `veriflow flows` | List saved flows (local, plus cloud when logged in) |
| `veriflow pause list` / `veriflow pause resolve <id> --answer <text>` | Manage human-in-the-loop pause requests (CI magic links) |
| `veriflow export --format playwright <run-id> [--out <path>]` | Playwright test from actions (stdout or `--out` file) |
| `veriflow import --from playwright <path>` | Best-effort flow (goto/click/fill/expect only) |
| `veriflow secrets [list\|set --key --value\|delete --key]` | Local AES-256-GCM secrets vault (values redacted pre-LLM and pre-storage) |
| `veriflow agent-test --endpoint <url> --scenarios N` | Chat-only eval |
| `veriflow redteam` | Reserved, not a security suite |
| `veriflow trace <run-id>` | Timeline + OTLP-shaped JSON |
| `veriflow metrics <flow-id>` | Pass rate / cost + reliability rollup (self-heal rate, human-intervention rate, step p50/p95) over local event logs; cloud if logged in |
| `veriflow budget get` | Print local caps |
| `veriflow budget set --run-cap <n> [--cost-cap <usd>]` | Local step/cost cap |

Destructive actions still need `--yes-i-mean-it` or `--dry-run`. Secrets are redacted before LLM and storage.

## Playwright import limits

Only simple `page.goto`, `.click()`, `.fill()`, `toContainText`, `toHaveURL`. No fixtures, page objects, or custom helpers.

## Agent testing

`veriflow agent-test` POSTs `{ messages }` to `--endpoint` and scores hallucination, task completion, context retention, tone/compliance, latency vs a small bundled scenario bank. Verdict: Green / Yellow / Red. No live LLM required for the default heuristic scorer.

The dashboard **Agent tests** page takes paste-JSON, or run evals directly: the CLI (`--scenarios N` scales a deterministic bank beyond the 12 hand-written scenarios — error handling, corrections, refusals, PII caution, topic switches) or `POST /v1/agent-tests`, which runs server-side and ingests the eval as a first-class run you can scrub like any other.

## Tests

```bash
pnpm test
pnpm typecheck
```

CI unit tests do not need provider keys. GitHub Actions (`.github/workflows/ci.yml`) runs on every push: build packages → typecheck (all workspaces) → full test suite (unit + golden flows) → web build, plus an `api-smoke` job that boots the API and probes `/health`, `/openapi.json`, auth, and run ingest.

### Golden-flow regression suite

`tests/golden/` runs the **real harness loop** (OBSERVE → DECIDE → GUARD → ACT → VERIFY, real Chromium) against a deterministic local test site with a scripted LLM provider — no network, no API keys, no LLM cost. **22 canonical golden tests** (21 harness flows + 1 suite-integrity placeholder) cover: login + heading assert, multi-step cart, evidence-pack creation, per-step screenshots, the secret-redaction guarantee (typed secrets never appear in stored events, even via GET-form URLs or password-field a11y snapshots), devtools-level asserts (`cookie_contains`, `local_storage`, `load_time_under`), an OTP human-pause flow, and a self-heal retry flow. Run the suite on every harness change and treat pass rate as the internal reliability metric.

Run a single golden file explicitly:

```bash
npx vitest run tests/golden/harness.golden.test.ts
```

## Monorepo

```
apps/cli          veriflow binary
apps/api          Hono API
apps/web          Next.js dashboard
apps/mcp          MCP HTTP/stdio
packages/schema   Zod Action / Run / Step / Span / billing
packages/harness  OBSERVE → DECIDE → GUARD → ACT → VERIFY (only execution engine)
packages/llm      Anthropic + OpenAI vision
packages/vault    AES-256-GCM + redaction + credentials
packages/evidence .testevidence zip
packages/telemetry spans + OTLP JSON
packages/store    filesystem run log + flows
tests/golden      22 canonical golden tests vs a deterministic local test site
```
