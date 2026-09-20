# ADR 0006: Hand-rolled integrations — what stays, what gets replaced

## Context

Several integrations are implemented on the Node stdlib instead of vendor
SDKs: SigV4 signing for S3/MinIO blobs, an inline SMTP client, Stripe webhook
HMAC verification, a cron parser, and the auth rate limiter. "Replace
hand-rolled code with vetted libraries where it reduces risk" was proposed.

## Decision

Evaluate each on (a) security correctness, (b) test coverage, (c) dependency
cost. Outcome: keep all of them, with named trigger points to replace.

## Consequences

- **SigV4 signing (keep).** Canonical request construction is subtle, but ours
  is ~100 lines, used for exactly one provider family, and exercised by the
  blob tests. The AWS SDK v3 is ~40 MB of transitive deps for the same
  result. Trigger to replace: if we ever need SigV4 features we don't
  implement (chunked uploads, session tokens, other AWS services).
- **Inline SMTP client (keep, watched).** Zero-dependency SMTP is the riskiest
  hand-roll here (TLS negotiation, MIME edge cases, provider quirks).
  Mitigations: it's only the delivery *path* — `VERIFLOW_EMAIL_ENDPOINT`
  (HTTP relay) is the recommended production config, and delivery failures
  are surfaced with retries, not swallowed. Trigger: any real-world
  deliverability issue → swap to Nodemailer or a provider SDK immediately.
- **Stripe webhook HMAC (keep).** The verification logic is 25 lines of
  well-specified HMAC + timestamp tolerance, tested with valid and forged
  signatures. The `stripe` package would pull a large SDK for one function.
  Trigger: adopting Stripe Checkout client-side flows (Elements, hosted
  widget customizations) → then the SDK earns its weight.
- **Cron parser (keep).** Fully unit-tested including the DOM/DOW
  restriction edge case. `cron-parser` would be fine too, but the parser is
  already correct and tested; swapping adds churn, not safety.
- **Rate limiter (keep, with a documented caveat).** In-memory buckets don't
  share state across replicas. This is documented in the code and the
  engineering report. Trigger: multi-replica deployment → move to Redis
  (or the DB) — at which point BullMQ from ADR 0004 may arrive together.
- General principle going forward: hand-rolling is allowed for
  single-purpose, well-tested protocol glue; it is not allowed for
  cryptography primitives, parsing of hostile input, or anything with a
  CVE surface.
