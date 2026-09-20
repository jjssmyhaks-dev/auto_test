# Architecture Decision Records

Short, permanent records for the decisions that shape Veriflow's architecture.
Format: Context → Decision → Consequences. Superseded ADRs are kept, not deleted.

| #   | Decision                                                            | Status    |
| --- | ------------------------------------------------------------------- | --------- |
| [0001](adr-0001-cli-commander.md)     | CLI framework: Commander (not oclif)                                 | Accepted |
| [0002](adr-0002-browser-playwright.md) | Browser execution: Playwright                                        | Accepted |
| [0003](adr-0003-harness-custom-loop.md) | Agent harness: custom state machine (not LangGraph/XState)           | Accepted |
| [0004](adr-0004-api-hono-not-nestjs.md) | Backend API: Hono, one service (not NestJS)                          | Accepted |
| [0005](adr-0005-postgres-app-level-tenancy.md) | Multi-tenancy: Postgres + app-level roles (RLS deferred)             | Accepted |
| [0006](adr-0006-hand-rolled-integrations.md) | Hand-rolled integrations: what stays, what gets replaced             | Accepted |
| [0007](adr-0007-mcp-official-sdk.md)  | MCP integration: official TypeScript SDK                             | Accepted |
| [0008](adr-0008-otel-shape-now-sdk-later.md)  | Observability: OTLP shape now, OpenTelemetry SDK when exporting out  | Accepted |

## Stack-evaluation verdict (2026-09)

The proposed stack was evaluated layer by layer. Verdicts:

| Layer                  | Proposal            | Verdict    | ADR    |
| ---------------------- | ------------------- | ---------- | ------ |
| CLI                    | oclif or Commander  | **Keep Commander** | [0001](adr-0001-cli-commander.md) |
| Browser execution      | Playwright          | **Confirmed as-is** | [0002](adr-0002-browser-playwright.md) |
| Agent harness          | Custom state machine| **Keep custom loop** (guardrails need deterministic aborts) | [0003](adr-0003-harness-custom-loop.md) |
| Backend API + MCP      | NestJS, one service | **Keep Hono** (lighter; MCP shares the store, not a DI container) | [0004](adr-0004-api-hono-not-nestjs.md) |
| Job execution          | BullMQ + Redis      | **Not adopted yet** — the CLI executes runs; when cloud-run queues land, revisit | — |
| Database               | Postgres + RLS      | **Keep Postgres + pg; RLS deferred** (app-level roles + workspaces today) | [0005](adr-0005-postgres-app-level-tenancy.md) |
| Blob storage           | S3-compatible       | **Already built** (SigV4 to S3/MinIO/R2) | [0006](adr-0006-hand-rolled-integrations.md) |
| Auth/storage bundle    | Supabase            | **Rejected for now** — replaces too much working code for no current pain | [0005](adr-0005-postgres-app-level-tenancy.md) |
| Model access           | Anthropic + OpenAI SDKs | **Already built** (pluggable providers) | — |
| MCP                    | Official TS SDK     | **Already used** | [0007](adr-0007-mcp-official-sdk.md) |
| Observability          | OpenTelemetry SDK   | **Shape now, SDK later** | [0008](adr-0008-otel-shape-now-sdk-later.md) |
| Dashboard              | Next.js             | **Confirmed as-is** | — |
| CI                     | GitHub Actions      | **Confirmed as-is** (typecheck + unit + golden + API smoke) | — |

Two proposals were accepted-in-spirit but not implemented: BullMQ-style job
queuing (ADR 0004 documents when to revisit) and a hosted Supabase-style auth
bundle (ADR 0005 documents why it's premature). Every other layer matches what
the codebase already does — the stack proposal was, on the whole, a validation
of the existing choices rather than a correction of them.
