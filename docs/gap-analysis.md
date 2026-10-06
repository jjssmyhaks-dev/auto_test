# Veriflow — gap analysis to world-class

Updated: 2026-10-05 (second pass). Everything below is verified against the code, not guessed.

## Legend

- 🔴 = blocks a real user from succeeding today
- 🟡 = works but breaks at scale / multi-replica / polish
- 🟢 = competitive-parity feature, not urgent

## Fixed in this pass (were dummy/broken)

| Gap | What was wrong | Fix |
| --- | --- | --- |
| Device cloud never returned results | `completeDeviceJob` existed in both stores but nothing ever called it — device workers executed jobs and dropped the results, so the devices page's "result shows up in Runs" was an empty promise | `veriflow device connect` now syncs every claimed run (`CloudClient.syncRun` → events, spans, evidence) and calls `POST /v1/device-jobs/:id/complete` |
| Dashboard queue and device queue were two disconnected systems | Runs queued from the web UI (`POST /v1/runs status:"queued"`) were never claimable — device claim only served explicit device jobs | `claimDeviceJob` (Memory + PG, atomic in PG) now falls back to claiming the oldest queued cloud run; the worker executes under the **same run id** (`runHarness({ runId })`), so the dashboard row updates in place: queued → running → passed/failed |
| Device workers streamed no live frames | Foreground `veriflow run --live` pushed frames, but `device connect` did not | Device workers now push frames per step (best-effort), so dashboard live view works for device-executed runs too |

## Closed in the second pass (2026-10-05, later commits)

| Gap | Fix |
| --- | --- |
| 🔴 Run ingest was trust-on-arrival | `POST /v1/runs` now validates event shape (known types, ISO timestamps, payload objects), enforces size caps (≤2k events, ≤2k spans, ≤50 files with per-file and total caps, 96MB body limit via `bodyLimit`), validates status/browser/attempt enums, and **derives cost server-side** from per-decide `usage` events the harness now emits — the client's top-level `costUsd` claim is only honored for legacy event streams, and never outside `[0, $50]` |
| 🔴 No keyless execution | Deterministic **recipe runs**: the flow's last passing run derives an action list (`GET /v1/flows/:id/recipe`), `runRecipe` in the harness replays it verbatim in a real browser with zero LLM calls, device jobs carry `mode:"recipe"`, workers fetch + execute + sync, and the flows page has a "Recipe run (no LLM)" button. CLI: `veriflow recipe <flowId>` |
| 🟡 Single replica only | `RateLimiter` and `LiveBus` are now injectable backends: `PgRateLimiter` (atomic `INSERT … ON CONFLICT … RETURNING` counters, swept lazily) and `PgLiveBus` (frames in a PG table, fan-out via `LISTEN/NOTIFY` — notifications carry only the row id, far under the 8KB limit). Wired automatically in `index.ts` when `DATABASE_URL` is set; covered by `scripts/pg-smoke.mjs` in CI |

## Remaining gaps

### 🔴 Real-user blockers

1. **Agent runs still need an LLM key on the worker** (recipes and replays are keyless now, but first-run discovery is agent-driven). A hosted-worker tier or bundled default recipes would close this.

### 🟡 Scale / production hardening

2. **Secrets in vault are local-only.** The CLI vault encrypts to a local file; cloud runs on other machines can't resolve `vaultKey` fills unless the secret is re-entered there. No cloud KMS/secret store integration.
3. **Email delivery via inline SMTP client** (`apps/api/src/deliver.ts`) — works but speaking raw SMTP from the API will trip SPF/DKIM/DMARC for real domains. Use an HTTP relay (Resend/SES/Postmark) in production: `VERIFLOW_EMAIL_ENDPOINT` already exists as the seam.
4. **Stripe tier-flip depends on webhook delivery.** Live Checkout + signature-verified webhook are real; there's no reconciliation job if a webhook is missed (no periodic Stripe sync of subscription status).
5. **Retention/audit coverage**: retention purge and audit log exist for core rows, but new tables added later must be added to both the purge routine and PG migrations (they're hand-maintained — e.g. `live_frames`/`rate_limit_windows` are self-sweeping, but check new tables).
6. **Observability of the platform itself**: no error tracking (Sentry-class), no product analytics, no structured server logs/metrics endpoint beyond `/health`. When a user's run fails at the API level, there's no trail.

### 🟢 Competitive parity / growth

9. **SCIM/SAML** directory sync + SSO groups (OIDC SSO exists; SCIM provisioning does not).
10. ~~**Python SDK**~~ **CLOSED 2026-10-06**: `sdks/python` ships a zero-dependency, typed client (submit runs, sync results, read traces, device jobs, recipes) with unit + live tests and a CI leg.
11. **Docs site**: single-page `/docs/api` + `/docs/mcp`; no versioning, search, or hosted docs. README covers install; no public quickstart video/GIF.
12. **i18n**: dashboard is English-only.
13. ~~**Real S3 dialect validation**~~ **CLOSED 2026-10-06**: validated against a real, independent S3 implementation (Garage, since MinIO community editions are discontinued/unpullable) via `scripts/smoke-s3.mjs` — 11/11 including paginated list (2400 keys), paginated delete, special-char keys. Two real dialect gaps found and fixed: valueless query params sign as `delete=`, and canonical URI/query now RFC 3986-encode (spaces, `+`, unicode).
14. **Mobile device emulation**: viewport action exists; no device profiles (iPhone/Pixel presets) or touch emulation.

## What already is real (audited, not dummy)

- **Execution**: real Playwright (chromium/firefox/webkit), real a11y-tree observation, real self-heal with committed repairs, real video/evidence packs, real network route mocks, real parallel suite runner with retry/quarantine policies.
- **Billing**: live Stripe Checkout when env is configured; signature-verified webhook flips the tier; quota + cost caps enforced server-side (402s).
- **Email/alerts**: inline SMTP client + HTTP relay + Slack + signed webhooks with retry/backoff, plus a send-test endpoint.
- **Auth**: sessions, API keys, OIDC SSO, workspaces/orgs with effective-role floors, per-IP rate limiting on credential endpoints, CSRF header check.
- **MCP**: real tools over the real API (run_flow, get_run, get_trace, export_playwright, list_flows).
- **PG**: full dual-store parity for every feature; migrations idempotent (`CREATE/ALTER ... IF NOT EXISTS`).
