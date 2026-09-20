# ADR 0004: Backend API — Hono, one service (not NestJS)

## Context

The proposal suggested NestJS with a shared HarnessModule so REST controllers
and MCP tool handlers both call the same logic ("don't fork the loop logic").
The API is currently a single Hono app (`apps/api`, ~1,500 lines) and the MCP
server (`apps/mcp`) is built on the official TypeScript SDK.

## Decision

Keep Hono for the API. Do not adopt NestJS. Preserve the no-fork invariant
through the *store and harness packages* instead of a DI container.

## Consequences

- The no-fork invariant is real and already holds — but it holds because the
  MCP tools call the same `@veriflow/harness` functions and the same store
  interface the API uses, not because a module system enforces it. That's
  sufficient: the fork risk lives in duplicated *logic*, and the logic lives
  in packages both apps import.
- Hono + @hono/node-server is ~2 MB of deps and sub-millisecond routing;
  NestJS is a full framework (decorators, DI, interceptors, pipes) whose
  payoffs target large teams on long-lived services. Veriflow's API is one
  file per concern with straightforward CRUD — NestJS structure would be
  ceremony.
- Migration cost is real: ~70 routes to re-shape into controllers/modules,
  plus the test suite. No offsetting pain today.
- Job queuing (BullMQ + Redis from the proposal) is deliberately not adopted
  yet: the CLI executes runs locally and the cloud path is synchronous for
  short runs. When cloud-run execution with streaming progress lands, add a
  queue and revisit whether the API service should split
  (control-plane/data-plane). Supersede this ADR at that point.
