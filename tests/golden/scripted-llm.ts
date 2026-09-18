import type { LlmProvider, DecideInput, DecideResult } from "@veriflow/llm";
import type { Action } from "@veriflow/schema";

/** A script entry: a static action, or a function of the observe context. */
export type ScriptStep = Action | ((input: DecideInput) => Action);

/**
 * Deterministic provider for the golden suite: runs a caller-supplied script of
 * steps (each receiving the redacted observe context) instead of calling an LLM.
 */
export function scriptedProvider(steps: ScriptStep[]): LlmProvider {
  let i = 0;
  return {
    name: "scripted",
    async decide(input: DecideInput): Promise<DecideResult> {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      const action = typeof step === "function" ? step(input) : step;
      return {
        raw: action,
        usage: { input: 100, output: 20, costUsd: 0.0001 },
        provider: "scripted",
        model: "scripted",
      };
    },
  };
}

/** Pick the a11y ref whose accessible name contains the given text (exact match preferred). */
export function refFor(input: DecideInput, text: string): string | undefined {
  // The compact tree is text: `@e1 [h1] Acme sign in` per line.
  const wanted = text.toLowerCase();
  const rows = input.a11yTree
    .split("\n")
    .map((line) => line.match(/^@(\S+)\s+\[(.+?)\]\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ ref: m[1], name: m[3].toLowerCase() }));
  return (rows.find((r) => r.name === wanted) ?? rows.find((r) => r.name.includes(wanted)))?.ref;
}
