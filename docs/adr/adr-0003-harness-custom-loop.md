# ADR 0003: Agent harness — custom state machine (not LangGraph/XState)

## Context

The agent loop (OBSERVE→DECIDE→GUARD→ACT→VERIFY) has hard guardrails: step
caps, wall-clock and cost budgets, loop detection, guard-fail aborts, and
human-pause halts. The proposal argued for a custom state machine over
LangGraph — reasoning that deterministic aborts are awkward in a
message-passing graph framework. XState was floated as a middle path.

## Decision

Keep the hand-written loop in `packages/harness/src/loop.ts`. Do not adopt
LangGraph, LangChain, or a formal state-machine library.

## Consequences

- Aborts must be deterministic: a guard fail or budget overrun stops the run
  *between* steps, mid-step work is discarded, and the run row records the
  terminal state. In the current design this is ~10 lines of checks at the
  top of the loop. Framework equivalents route aborts through their own
  scheduler — harder to reason about, and a misroute means a runaway browser.
- The loop is ~600 lines including evidence capture, span emission, and
  retries. Every line is domain logic; a framework would add abstraction on
  top, not remove any of it.
- Testability: the golden suite drives the loop against a local test site and
  stub LLMs. State-machine libraries make that testable too, but the loop's
  current shape means the tests exercise real code paths directly.
- XState was considered seriously. It would formalize states/transitions but
  adds a dependency and a conceptual model that must be taught to every new
  engineer, for a machine that is simple enough to read as code. Revisit if
  the loop grows interactive branching beyond human-pauses.
- LangGraph remains rejected: it excels at chat-style agent flows with
  dynamic branching; Veriflow's loop is a fixed cycle with hard gates.
