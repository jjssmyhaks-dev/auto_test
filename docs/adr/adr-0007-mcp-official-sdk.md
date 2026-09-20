# ADR 0007: MCP integration — official TypeScript SDK

## Context

The proposal recommended the official TypeScript MCP SDK. The MCP server
(`apps/mcp`) was built on `@modelcontextprotocol/sdk` from the start, exposing
run_flow, get_trace, list_flows, queue_run, human-pause, and evidence tools
over both stdio and HTTP.

## Decision

Keep the official TypeScript SDK. No alternative considered seriously.

## Consequences

- The SDK handles protocol versioning, capability negotiation, and transport
  plumbing that we would otherwise hand-roll against a moving spec — this is
  precisely the category of code ADR 0006 says not to hand-roll.
- The no-fork invariant (ADR 0004) holds here: MCP tools call the same store
  and harness functions the REST API uses. The SDK's server abstraction made
  that split trivial — tool handlers are thin.
- Cost of leaving: protocol churn would land on us. There is no scenario
  where maintaining a private MCP implementation beats the official SDK.
