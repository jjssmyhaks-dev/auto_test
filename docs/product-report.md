# Veriflow — Product Report & User Guide

**Version 0.2 · September 2026**

*Local-first vision browser testing: plain-English objectives in, verified evidence out.*

---

## 1. What is Veriflow?

Veriflow tests websites and chat agents the way a careful human would — by **looking at the page** and **keeping receipts**.

You write an objective in plain English:

> *"Log in, add a plan to the cart, assert the total"*

and Veriflow drives a real Chromium browser, decides each next action with a vision LLM, enforces guardrails, redacts your secrets, and packages everything it did — screenshots, traces, network, console — into a shareable evidence pack.

**The three principles:**

1. **Local-first.** The browser runs on *your* machine. Nothing leaves it unless you sync. No LLM key, no cloud account — you can still run, replay, and export.
2. **Vision, not brittle selectors.** The agent looks at an accessibility snapshot + screenshot, like a human tester. It self-heals when the UI shifts.
3. **Evidence discipline.** Every run is a replayable, exportable, shareable record — the artifact *is* the truth, not a green checkmark.

---

## 2. What can it do today?

### Browser testing (the CLI engine)

| Capability | How |
| --- | --- |
| Plain-English objectives | `veriflow run "log in, add a plan to the cart, assert the total" --env https://staging.example.com` |
| Headless CI mode | `--headless` — exit 0 on pass, 1 on fail |
| Deterministic regression | `veriflow replay <run-id> --live` re-executes the recorded actions *without re-paying for LLM decisions* |
| Parallel suites | `veriflow suite --all --concurrency 4` — many flows, bounded worker pool, each worker its own browser |
| Secrets | `veriflow secrets set --key staging_password` — AES-256-GCM vault; values are redacted before the LLM sees anything and before storage |
| Budget guardrails | `veriflow budget set --run-cap 30 --cost-cap 2.00` — the loop halts itself before runaway agents |
| Devtools capture | `--devtools` records network/console/performance; assertions like `cookie_contains`, `local_storage`, `load_time_under` |
| OTLP export | `--otlp` writes OTel-shaped JSON for your observability stack |
| Playwright interop | `veriflow export --format playwright <run-id>` / `veriflow import --from playwright <path>` |
| Human-in-the-loop | OTP or 2FA mid-flow pauses the run; resolve from the CLI (`veriflow pause resolve`) or API — built for CI |

### Agent (chat LLM) testing

`veriflow agent-test --endpoint http://localhost:8788/chat` runs a bundled multi-turn scenario bank (greetings, corrections, PII caution, topic switches — 12 hand-written, deterministically scalable to 40+) and scores **hallucination, task completion, context retention, tone/compliance, latency**, issuing a **Green / Yellow / Red go-live verdict**.

- **Voice mode:** `--mode voice` applies telephony-style latency gates (3s per turn) for voice/IVR agents.
- **Red team:** `veriflow redteam` fires 8 attack probes — prompt injection, jailbreaks, PII extraction, phishing — where *refusal scores as a pass*.

### Scheduling (regression on autopilot)

Give any saved flow a cron expression (`*/30 * * * *`, `0 9 * * 1-5`), then let any scheduler poll the claim endpoint:

```bash
# crontab / GitHub Actions / K8s CronJob — every minute:
veriflow schedules due --execute --concurrency 4
```

Claims are idempotent per minute; each due flow runs exactly once. Or skip the cloud entirely: `veriflow suite --all` in CI.

### The dashboard (apps/web)

- **/runs** — queue objectives from the browser; run history with filters
- **/runs/:id** — the **trace scrubber**: scrub the run like a video, filmstrip of all step screenshots, network + console timelines
- **/runs/compare** — pick two runs, get a side-by-side step diff, similarity score, and screenshot links
- **/flows** — save flows, re-run them, attach cron schedules, per-flow reliability rollups (success %, self-heal %, intervention %, cost)
- **/agent-test** — run and review chat-agent evals with full transcripts
- **/evidence** — download evidence packs
- **/usage** — quota, ledger, and the activation funnel (team tier)
- **/alerts** — alert rules (cost spikes, success-rate drops) with webhook delivery
- **/devices** — register your machines as workers and queue objectives for them
- **/docs/cli, /docs/mcp** — quickstarts, right in the app
- **/settings** — reset onboarding, reset demo data

A **guided tour** (Guided or hands-on *Try-it* mode), per-page `?` hints, and a getting-started checklist walk new users through the flow — and the progress follows your account across devices.

### MCP (for coding agents)

Claude Code, Cursor, or any MCP client can drive Veriflow mid-session:

```json
{ "mcpServers": { "veriflow": {
    "command": "pnpm",
    "args": ["--filter", "@veriflow/mcp", "start", "--", "--stdio"],
    "env": { "VERIFLOW_API_KEY": "vf_…" } } } }
```

Tools: `run_flow`, `get_run`, `get_trace`, `export_playwright`, `list_flows`, `list_runs`. Your coding agent can verify its own work without leaving the chat.

### Cloud API & accounts (optional)

Sign up, sync runs, and get: projects with scoped API keys, run history, evidence blob storage, usage quotas (Free 50 / Starter 500 / Team 5,000 runs per month), alert rules, metric rollups, scheduling, device cloud, and Stripe billing. Without an account, everything above still works locally.

### Hosted device cloud

Turn any spare machine into a worker: `veriflow device connect` registers it with the cloud. Queue objectives from /devices; the first online device claims the job (FIFO) and the run appears in your history.

---

## 3. Getting started (5 minutes)

```bash
# 1. Install
pnpm install && pnpm build && pnpm playwright:install

# 2. Run your first objective (needs an LLM key for browser runs)
export ANTHROPIC_API_KEY="sk-…"
pnpm --filter @veriflow/cli start -- run "open https://example.com and assert the heading contains Example" --headless

# 3. Look at the receipts
pnpm --filter @veriflow/cli start -- trace <run-id>
```

Full stack (optional): `docker compose up -d` for Postgres + MinIO, then `pnpm --filter @veriflow/api start` (:8787) and `pnpm --filter @veriflow/web dev` (:3000). See the README for details, or the in-app docs pages.

---

## 4. What Veriflow is not (yet)

An honest list, so you can plan around it:

- No **video recording** of runs (screenshots only, today)
- No **email/Slack delivery** for alerts or pause magic links (webhook + CLI/API today)
- Chromium only — no Firefox/WebKit yet
- No **flow version history** — saving a flow overwrites it
- No member roles/invites — "Team" is a quota tier, not a permission system
- No retention TTLs on evidence — you manage storage
- Playwright import handles simple goto/click/fill/2 assertions
- Browser `run` needs an LLM key (replay/agent-test/red-team don't)

---

## 5. Quality you can verify

- **84 automated tests** across 18 files, including a 22-test **golden suite** that drives real Chromium against a deterministic local site with a scripted LLM — no network, no keys, no cost — covering login/cart flows, evidence packs, the secret-redaction guarantee, devtools asserts, OTP pauses, and self-heal retries.
- **CI on every push**: build → typecheck (all 11 workspaces) → full tests → web build → API smoke (boots the API, probes health/openapi/auth/ingest).
- Typecheck-clean monorepo (strict TypeScript, Zod-validated schemas at every boundary).

---

*Veriflow · local-first vision browser testing · v0.2*
