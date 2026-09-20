# ADR 0001: CLI framework — Commander (not oclif)

## Context

The proposed stack suggested oclif (or Commander) for the CLI. Veriflow's CLI
(`apps/cli`) was already built on Commander with ~20 commands (`run`, `suite`,
`schedules`, `redteam`, `device`, `agent-test`, `flows`, …) and imports the
harness library directly.

## Decision

Keep Commander. Do not migrate to oclif.

## Consequences

- Commander is ~50 KB of dependency surface; oclif brings its own plugin
  runtime, base classes, and config conventions. For a single-purpose
  developer tool, that machinery buys nothing.
- oclif's payoffs (auto-generated help pages, plugin discovery, hook system)
  matter for large multi-command ecosystems. Veriflow's help output is
  hand-written and stable.
- The "one language, zero serialization overhead" property in the proposal
  holds either way: the CLI imports `@veriflow/harness` directly. Framework
  choice doesn't affect that.
- Cost of leaving: none today. If the CLI ever grows plugins or third-party
  extensions, oclif becomes worth re-evaluating (supersede this ADR then).
