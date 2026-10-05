# Veriflow — gap analysis to world-class

Updated: 2026-10-05. Everything below is verified against the code, not guessed.

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

## Remaining gaps

### 🔴 Real-user blockers

1. **Browser execution needs an LLM key on the worker.** `runHarness` is agent-driven (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`); there is no managed key by design (BYOK). A user with no key anywhere cannot execute agent runs. Deterministic `replayLive` exists but only replays previously-recorded action sequences. *Options:* flow-step "recipes" (explicit steps, no LLM), or a hosted-worker tier.
2. **Single replica only.** The API holds hot state in process: `MemoryStore` (default when `DATABASE_URL` is unset), the fixed-window rate limiter (`apps/api/src/store.ts` `rateLimit`), and the SSE live bus (`apps/api/src/live.ts` `recentFrames`/`subscribe`). Two API replicas behind a load balancer will drop frames, double-serve rate budgets, and split state. PG covers persistence but not these three.
3. **Run ingest is trust-on-arrival.** `POST /v1/runs` accepts any `status`/`events`/`costUsd` from any authenticated project member. A worker bug (or bad actor) can mark flaky flows green. *Options:* server-side re-verification, event schema validation with size caps, and per-key ingest signing.

### 🟡 Scale / production hardening

4. **Secrets in vault are local-only.** The CLI vault encrypts to a local file; cloud runs on other machines can't resolve `vaultKey` fills unless the secret is re-entered there. No cloud KMS/secret store integration.
5. **Email delivery via inline SMTP client** (`apps/api/src/deliver.ts`) — works but speaking raw SMTP from the API will trip SPF/DKIM/DMARC for real domains. Use an HTTP relay (Resend/SES/Postmark) in production: `VERIFLOW_EMAIL_ENDPOINT` already exists as the seam.
6. **Stripe tier-flip depends on webhook delivery.** Live Checkout + signature-verified webhook are real; there's no reconciliation job if a webhook is missed (no periodic Stripe sync of subscription status).
7. **Retention/audit coverage**: retention purge and audit log exist for core rows, but new tables added later must be added to both the purge routine and PG migrations (they're hand-maintained).
8. **Observability of the platform itself**: no error tracking (Sentry-class), no product analytics, no structured server logs/metrics endpoint beyond `/health`. When a user's run fails at the API level, there's no trail.

### 🟢 Competitive parity / growth

9. **SCIM/SAML** directory sync + SSO groups (OIDC SSO exists; SCIM provisioning does not).
10. **Python SDK** (`@veriflow/sdk` is TypeScript; agents in Python must use raw REST).
11. **Docs site**: single-page `/docs/api` + `/docs/mcp`; no versioning, search, or hosted docs. README covers install; no public quickstart video/GIF.
12. **i18n**: dashboard is English-only.
13. **Real S3 dialect validation**: `S3BlobStore` list/delete math is verified against a fake S3; run once against real MinIO/R2/AWS before shipping that path to customers.
14. **Mobile device emulation**: viewport action exists; no device profiles (iPhone/Pixel presets) or touch emulation.

## What already is real (audited, not dummy)

- **Execution**: real Playwright (chromium/firefox/webkit), real a11y-tree observation, real self-heal with committed repairs, real video/evidence packs, real network route mocks, real parallel suite runner with retry/quarantine policies.
- **Billing**: live Stripe Checkout when env is configured; signature-verified webhook flips the tier; quota + cost caps enforced server-side (402s).
- **Email/alerts**: inline SMTP client + HTTP relay + Slack + signed webhooks with retry/backoff, plus a send-test endpoint.
- **Auth**: sessions, API keys, OIDC SSO, workspaces/orgs with effective-role floors, per-IP rate limiting on credential endpoints, CSRF header check.
- **MCP**: real tools over the real API (run_flow, get_run, get_trace, export_playwright, list_flows).
- **PG**: full dual-store parity for every feature; migrations idempotent (`CREATE/ALTER ... IF NOT EXISTS`).
