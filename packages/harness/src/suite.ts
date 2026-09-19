import { runHarness } from "./loop.js";
import type { RunResult } from "./loop.js";

/**
 * Parallel flow execution: run many objectives concurrently with a bounded
 * worker pool. Each worker launches its own browser (the pool size is the
 * concurrency knob), and results come back in submission order so reports
 * stay stable regardless of timing.
 */

export interface SuiteFlowResult {
  flowId?: string;
  name: string;
  objective: string;
  envUrl?: string;
  result?: RunResult;
  error?: string;
  /** Wall-clock ms for this individual flow. */
  durationMs: number;
}

export interface SuiteResult {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  concurrency: number;
  results: SuiteFlowResult[];
}

export interface SuiteFlowInput {
  flowId?: string;
  name: string;
  objective: string;
  envUrl?: string;
}

export interface SuiteOptions {
  /** Max browsers in flight (default 4). */
  concurrency?: number;
  headless?: boolean;
  home?: string;
  /** Provider override for tests (scripted LLM). */
  provider?: Parameters<typeof runHarness>[0]["provider"];
  /** Called after each flow finishes — for live progress output. */
  onFlowDone?: (result: SuiteFlowResult, done: number, total: number) => void;
  /** Per-flow harness options hook (e.g. pause handlers). */
  runOptions?: Partial<Parameters<typeof runHarness>[0]>;
}

/**
 * Execute flows with a bounded worker pool. Failures never abort the suite —
 * every flow gets a result; exit decision is left to the caller.
 */
export async function runSuite(flows: SuiteFlowInput[], opts: SuiteOptions = {}): Promise<SuiteResult> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, flows.length || 1));
  const t0 = Date.now();
  const results: SuiteFlowResult[] = new Array(flows.length);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < flows.length) {
      const index = cursor++;
      const flow = flows[index];
      const started = Date.now();
      try {
        const result = await runHarness({
          objective: flow.objective,
          envUrl: flow.envUrl,
          headless: opts.headless ?? true,
          home: opts.home,
          provider: opts.provider,
          ...opts.runOptions,
        });
        results[index] = { flowId: flow.flowId, name: flow.name, objective: flow.objective, envUrl: flow.envUrl, result, durationMs: Date.now() - started };
      } catch (err) {
        results[index] = {
          flowId: flow.flowId,
          name: flow.name,
          objective: flow.objective,
          envUrl: flow.envUrl,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        };
      }
      done++;
      opts.onFlowDone?.(results[index], done, flows.length);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const passed = results.filter((r) => r.result?.status === "passed").length;
  return {
    total: flows.length,
    passed,
    failed: flows.length - passed,
    durationMs: Date.now() - t0,
    concurrency,
    results,
  };
}

/** Convenience: run the same objective shape many times (e.g. smoke across envs). */
export function runFlowsParallel(flows: SuiteFlowInput[], concurrency = 4) {
  return runSuite(flows, { concurrency });
}
