# ADR 0005: Multi-tenancy — Postgres + app-level roles (RLS deferred, Supabase rejected for now)

## Context

Multi-tenancy today: every row carries a project id; access goes through the
store's `effectiveRoleFor` (project membership + workspace floor), enforced in
each route. The proposal suggested Postgres RLS for tenant isolation "for
free", and Supabase as an auth+storage bundle.

## Decision

Keep application-level tenancy checks. Defer RLS. Do not adopt Supabase.

## Consequences

- The app must dual-run on an in-memory store (tests, local dev) and Postgres
  (production). RLS is invisible to the in-memory store, so the test suite
  could never verify tenant isolation — the guarantee would live only in
  production SQL policies. That split is exactly how isolation bugs slip
  through green CI. App-level checks run identically in both stores and are
  exercised by the 89-test suite.
- RLS is not rejected forever — it's deferred with a trigger: when real
  customer data hits the Postgres deployment, add RLS policies as a second
  belt behind the app checks (defense in depth, not a replacement). Write
  that as a new ADR at adoption time.
- Supabase: the API already has sessions, scrypt password hashing, API keys,
  rate limiting, team roles, and workspaces — all tested. Supabase would
  replace auth but also force the blob store and DB onto its shapes, for
  problems we don't currently have. The storage half (S3-compatible blobs)
  is already built and provider-agnostic (MinIO/R2 work today).
- Cost of the current path: every new route must call `requireRole`/
  `requireWorkspaceRole`. The workspace test proves the failure mode
  (missing gate → cross-tenant write) is caught by review + tests, not by
  the database. This is the honest tradeoff: more discipline, more visibility.
