# Veriflow — Engineering Report

**Version 0.2 · September 2026 · For the build team**

*Architecture, data model, conventions, operations, and roadmap of the Veriflow monorepo. Pair with `docs/product-report.md` (user-facing) and `README.md` (setup).*

---

## 1. System overview

```
                       ┌──────────────────────────────────────────────┐
                       │                 apps/web (Next.js)           │
                       │  dashboard, trace scrubber, tour/onboarding  │
                       └───────────────┬──────────────────────────────┘
                                       │ REST (JSON, bearer or cookie)
┌──────────────┐   stdout/NDJSON  ┌────┴───────────────────────────────┐
│  apps/cli    │─────────────────▶│          apps/api (Hono)           │
│  veriflow    │                  │  :8787 · auth, runs, flows,        │
│  engine host │◀─────────────────│  schedules, devices, billing,      │
└──────────────┘   sync (opt-in)  │  alerts, progress, compare         │
       │                          └────┬───────────────┬───────────────┘
       │                               │               │
       ▼                        MemoryStore      PgStore (+ S3 blobs)
┌─────────────────────────────────┐  (file-backed)   (docker compose)
│ packages/harness                │
│ OBSERVE → DECIDE → GUARD →      │        ┌──────────────────────┐
│ ACT → VERIFY over Playwright    │        │  apps/mcp (MCP)      │
│ + cron, suite pool, compare,    │        │  HTTP :3333 / stdio  │
│ agent-test, red-team, replay    │        └──────────────────────┘
└─────────────────────────────────┘
```

**The only execution engine is `packages/harness`.** CLI, MCP, and the golden suite are all thin clients over it. If you change how testing works, you change it there — once.

## 2. Monorepo map

| Path | What | Key facts |
| --- | --- | --- |
| `apps/cli` | `veriflow` binary (commander) | 635 lines; run/replay/suite/schedules/export/import/secrets/agent-test/redteam/pause/device/budget/flows/login |
| `apps/api` | Hono REST API | `app.ts` (~1,150 lines) holds all routes; `index.ts` boots; stores swappable |
| `apps/web` | Next.js 15 dashboard | 15 routes + components (scrubber, tour, hints, checklist); Tailwind 4 + Vercel AI Elements |
| `apps/mcp` | MCP server | 6 tools; HTTP + stdio; API fallback auth via `VERIFLOW_API_KEY` |
| `packages/schema` | Zod schemas | Action/Run/Step/Span/Flow/billing/tiers — single source of truth |
| `packages/harness` | The engine + libs | loop, guards, act, devtools, agent-test, red-team bank, cron, suite pool, compare, replay-live, metrics, cloud client |
| `packages/llm` | Vision providers | Anthropic + OpenAI, factory-select by env key |
| `packages/vault` | Secrets | AES-256-GCM vault, credentials store, `redactDeep` |
| `packages/evidence` | Evidence packs | JSZip `.testevidence` bundles |
| `packages/telemetry` | Spans | SpanRecorder + OTLP-JSON export |
| `packages/store` | Local run store | filesystem event logs, flows, config |
| `tests/golden` | Regression suite | real Chromium + scripted LLM vs deterministic local site |

pnpm workspaces (`pnpm-workspace.yaml`): `apps/*`, `packages/*`. Node 20+, pnpm 9.

## 3. The harness loop (read this first)

`packages/harness/src/loop.ts` — every browser run is:

1. **OBSERVE** — accessibility snapshot (+ screenshot) of the page
2. **DECIDE** — vision LLM returns one constrained `Action` (Zod-validated against `ActionSchema`: navigate/click/fill/select/hover/scroll/wait/assert/finish/request_human)
3. **GUARD** — `guards.ts` veto layer: step caps, loop detection, destructive-action gating (`--yes-i-mean-it`), cost/token budgets, dry-run
4. **ACT** — Playwright executes; **self-heal** = re-observe + retry on failure
5. **VERIFY** — assertion check; every step emits an event + spans

Everything downstream — replay (`replay --live` re-executes recorded actions deterministically, no LLM), evidence packs, sync, metrics — consumes this event stream. Never write features that bypass events.

## 4. Data model (API)

Two store implementations behind `CloudStore` (`apps/api/src/store.ts` interface): **MemoryStore** (JSON file-persisted, zero-dep default) and **PgStore** (`pg.ts`, docker-compose Postgres). Every feature lands in *both*. Tables:

`users, sessions, projects, api_keys, runs, steps, spans, flows, alert_rules, human_pauses, metric_rollups, user_progress, devices, device_jobs`

Key semantics worth knowing:

- **Auth**: password (scrypt) → session bearer token OR `x-api-key` (project-scoped) OR httpOnly `vf_session` cookie. Sessions expire at 30 days (enforced on read; purged hourly). Auth endpoints rate-limited 10/5min per IP (fixed window, in-memory).
- **Tiers**: `free(50)/starter(500)/team(5000)` runs/month on cloud ingest → 402 `quota_exceeded`. Funnel + demo-reset endpoints are team-gated (403).
- **Onboarding/tour progress** (`user_progress`): PUT **unions** `onboardingDone` server-side (multi-device safe); `tourStep` is last-write-wins; `null` clears it.
- **Schedules**: `flows.schedule` (validated cron) + `lastScheduledAt`; `POST /v1/schedules/claim` is **idempotent per minute** (safe for any external poller).
- **Devices**: register → heartbeat → FIFO `claimDeviceJob` (single UPDATE … LIMIT 1 pattern) → `completeDeviceJob(runId)`.
- **Metric rollups**: precomputed per-flow 7/30-day windows (`refresh` endpoint); dashboards never scan raw spans.
- **Stripe**: `STRIPE_SECRET_KEY` + price IDs → Checkout Session; webhook verifies `t=…,v1=…` HMAC (5-min tolerance) then `setTier`. No keys → simulated upgrade (dev).

## 5. Conventions & rules of the road

- **TypeScript strict everywhere**; `pnpm typecheck` must stay 11/11 workspaces green. Zod-validate at every boundary (`schema` package); don't invent ad-hoc shapes.
- **Tests**: 84 across 18 files (`npx vitest run`). The golden suite (`tests/golden/`, real Chromium, scripted LLM, zero network) is the reliability gate — run it on any harness change. New API features ship with a test in `app.test.ts`; new harness libs with unit tests next to the source.
- **CI** (`.github/workflows/ci.yml`, runs on every push): build packages → typecheck → full tests → web build → `api-smoke` job (boots API, probes `/health`, `/openapi.json`, auth + ingest round-trip). **Order matters**: packages build *before* typecheck (package types resolve from `dist`).
- **Secrets**: never log or store secret values; route user secrets through `packages/vault` (`redactSecrets` before LLM and storage — golden-tested).
- **Commits**: imperative subject + body explaining *why*; CI footer (`🤖 Generated with Codebuff`). Push to `main` triggers CI; watch it with `gh run watch`.
- **Docs discipline**: README documents every user-visible surface; `.freebuff/run.md` documents local server procedures (this machine's global `PORT=:0` env var requires pinned launchers — see that file before starting servers).

## 6. Local development

```bash
pnpm install
pnpm build                      # packages + apps
pnpm --filter @veriflow/api start        # API :8787
pnpm --filter @veriflow/web dev          # web :3000
pnpm test && pnpm typecheck              # the gate
npx vitest run tests/golden/harness.golden.test.ts   # engine gate
docker compose up -d                     # optional Postgres + MinIO
```

No `.env` required to boot: API defaults to MemoryStore + filesystem blobs (`.veriflow-data/`). Demo data: `node scripts/seed-demo-run.mjs http://127.0.0.1:8787`.

## 7. Known gaps / debt register (as of v0.2)

| Area | Gap | Where it bites |
| --- | --- | --- |
| Delivery | No email/Slack for alerts or pause links; webhook is fire-and-forget, no retry | `app.ts` alert delivery, human-pauses |
| Blobs | `S3BlobStore.deleteByPrefix` is a stub (fs store only) | demo reset on S3 deployments |
| Browsers | Chromium only | harness `loop.ts` |
| Media | No run video recording | scrubber/evidence |
| Flows | No version history; save overwrites | flows store + API |
| Teams | No member roles/invites; tier ≠ permissions | all team-gated endpoints |
| Retention | No TTL/storage quotas on evidence | blob stores |
| Import | Playwright import limited to goto/click/fill/2 asserts | `playwright-interop.ts` |
| OTLP | Shape-only JSON export, not a collector | `telemetry` |
| Rate limit | In-memory fixed window — resets on restart, not shared across replicas | `store.ts` |
| Env quirk | Machine global `PORT=:0` breaks default binds — pinned launchers documented in `.freebuff/run.md` | local ops |

## 8. Roadmap (priority order)

1. **Alert/pause delivery channels** — email (Resend/SES) + Slack with retry; per-rule channel config
2. **Video recording** — Playwright `recordVideo` per run; surface in scrubber + evidence
3. **Team member roles** — invites, project membership, role checks replacing tier gates
4. **Flow versioning** — version history, diff, "last passing version" pinning
5. **Retention policies** — per-project TTL + storage quota enforcement
6. **Firefox/WebKit** — harness browser launch parameterization + golden coverage
7. **Rate-limit backend** — move to Postgres window table (or Redis) for multi-replica
8. **Live OTLP collector endpoint** — accept spans from customer infra
9. **Run diffing v2** — screenshot pixel-diff with visual highlight overlay
10. **Dark mode / i18n** — dashboard polish

## 9. Where things live (cheat sheet)

| Task | File(s) |
| --- | --- |
| Add/modify an API route | `apps/api/src/app.ts` (+ test, + OpenAPI paths map at top) |
| Change the test engine | `packages/harness/src/loop.ts`, `act.ts`, `guards.ts` |
| Add an MCP tool | `apps/mcp/src/tools.ts` |
| Add a dashboard page | `apps/web/app/<route>/page.tsx` (+ nav in `components/site-chrome.tsx`, hint via `AppPage hint`) |
| Add a shared schema | `packages/schema/src/index.ts` |
| Add a cron-backed feature | `packages/harness/src/cron.ts` |
| Change scheduling semantics | `claimDueFlows` in both stores + `/v1/schedules/claim` |
| Onboarding/tour logic | `apps/web/lib/onboarding.ts`, `components/tour-guide.tsx` |
| Alert evaluation | `computeAlerts` in `store.ts` + rules routes in `app.ts` |

---

*Veriflow engineering · v0.2 · 18 test files / 84 tests / 11 workspaces, CI green*
