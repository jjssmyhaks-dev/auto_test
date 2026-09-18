# Veriflow

Local-first **vision browser testing**. The CLI (`veriflow`) drives Chromium with Playwright, asks a vision LLM for the next constrained action, enforces guardrails, redacts secrets, and writes a local evidence pack. Cloud API, dashboard, MCP, Playwright interop, chat agent-tests, and billing quotas are implemented for local use.

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
- `GET /v1/alerts` — `cost_spike` / `success_rate` (log / webhook stub); dashboard `/alerts`

### Dashboard

```bash
$env:NEXT_PUBLIC_API_URL="http://127.0.0.1:8787"
pnpm --filter @veriflow/web dev     # :3000
```

Usable pages: sign up/login, **queue an NL objective** on `/runs` (cloud record; harness still runs on CLI), run evidence/trace (`/evidence` and `/runs/:id` — AI Elements conversation, reasoning, chain-of-thought timeline, tool/action cards), agent-test transcripts (`/agent-test`), project API keys, usage/upgrade, alerts.

The dashboard uses **Vercel AI Elements** (`npx ai-elements@latest` / source under `apps/web/components/ai-elements`). Peers: `ai`, `@ai-sdk/react`, Tailwind 4, shadcn/ui. No live LLM is required to render traces or sample eval chats.

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
| `veriflow run "<objective>" [--headless] [--env] [--profile] [--devtools] [--otlp] [--sync] [--agent] [--yes-i-mean-it] [--dry-run]` | Harness |
| `veriflow replay <run-id>` | Local event log |
| `veriflow login --email --password [--signup] [--api-url]` | Encrypted credentials |
| `veriflow profiles [list\|set --name --env]` | Named env URLs |
| `veriflow export --format playwright <run-id>` | Playwright test from actions |
| `veriflow import --from playwright <path>` | Best-effort flow (goto/click/fill/expect only) |
| `veriflow agent-test --endpoint <url> --scenarios N` | Chat-only eval |
| `veriflow redteam` | Reserved, not a security suite |
| `veriflow trace <run-id>` | Timeline + OTLP-shaped JSON |
| `veriflow metrics <flow-id>` | Pass rate / cost (local event logs; cloud if logged in) |
| `veriflow budget get` | Print local caps |
| `veriflow budget set --run-cap <n> [--cost-cap <usd>]` | Local step/cost cap |

Destructive actions still need `--yes-i-mean-it` or `--dry-run`. Secrets are redacted before LLM and storage.

## Playwright import limits

Only simple `page.goto`, `.click()`, `.fill()`, `toContainText`, `toHaveURL`. No fixtures, page objects, or custom helpers.

## Agent testing

`veriflow agent-test` POSTs `{ messages }` to `--endpoint` and scores hallucination, task completion, context retention, tone/compliance, latency vs a small bundled scenario bank. Verdict: Green / Yellow / Red. No live LLM required for the default heuristic scorer.

Paste that JSON into the dashboard **Agent tests** page, or submit `sample` to preview the conversation UI.

## Tests

```bash
pnpm test
pnpm typecheck
```

CI unit tests do not need provider keys.

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
tests/golden      placeholder flows (example.com)
```
