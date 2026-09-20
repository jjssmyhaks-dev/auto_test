# ADR 0008: Observability — OTLP shape now, OpenTelemetry SDK when exporting out

## Context

The harness emits spans in the OTLP JSON shape and the API can export them
(`spansToOtlp`), but there is no live OTLP collector endpoint and no
OpenTelemetry SDK dependency. The proposal recommended adopting the real
OpenTelemetry TS SDK now so later export to Datadog/Honeycomb is free.

## Decision

Keep emitting OTLP-shaped spans without the SDK. Adopt the OpenTelemetry SDK
when a customer-facing export target actually exists.

## Consequences

- The spans we emit are already spec-shaped, so the future migration is
  mechanical: map our span objects onto the SDK's tracer API at the harness
  boundary (one integration point, since everything consumes events).
- Adopting the SDK today would buy nothing: there is no collector to export
  to, the SDK adds runtime weight to every browser run, and its context
  propagation model assumes in-process async traces — the harness's spans
  cross a process boundary (browser run → API → dashboard) that the SDK
  doesn't manage for us.
- The known gap remains honest: OTLP export is shape-only today. It's on the
  roadmap (see the engineering report's gap register) with the SDK as the
  implementation vehicle, not a rewrite.
