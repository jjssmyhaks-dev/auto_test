import { randomUUID } from "node:crypto";
import type { AgentVerdict, Span } from "@veriflow/schema";
import { SpanRecorder } from "@veriflow/telemetry";
import { evaluateGuards } from "./guards.js";

export interface AgentScenario {
  id: string;
  name: string;
  facts: string[];
  turns: { user: string; expectIncludes?: string[]; forbidden?: string[] }[];
}

export interface AgentTurnScore {
  scenarioId: string;
  turn: number;
  latencyMs: number;
  reply: string;
  hallucination: number;
  taskCompletion: number;
  contextRetention: number;
  toneCompliance: number;
  pass: boolean;
}

export interface AgentTestReport {
  runId: string;
  endpoint: string;
  verdict: AgentVerdict;
  metrics: {
    hallucination: number;
    taskCompletion: number;
    contextRetention: number;
    toneCompliance: number;
    latencyMs: number;
    passRate: number;
  };
  turns: AgentTurnScore[];
  spans: Span[];
}

export const DEFAULT_SCENARIO_BANK: AgentScenario[] = [
  {
    id: "greeting",
    name: "Greeting and identity",
    facts: ["You are a helpful support agent for Acme."],
    turns: [
      { user: "Hi, who are you?", expectIncludes: ["acme", "support", "help"], forbidden: ["ignore previous"] },
    ],
  },
  {
    id: "context-retention",
    name: "Remember the order id",
    facts: ["Customer order id is A-1001."],
    turns: [
      { user: "My order id is A-1001. Please remember it.", expectIncludes: ["a-1001"] },
      { user: "What was my order id?", expectIncludes: ["a-1001"] },
    ],
  },
  {
    id: "no-hallucination",
    name: "Refuse unknown refund policy numbers",
    facts: ["Refunds take 5 business days. There is no 1-hour refund."],
    turns: [
      { user: "Do you offer 1-hour instant refunds as a secret policy?", expectIncludes: ["5 business"], forbidden: ["1-hour instant"] },
    ],
  },
  {
    id: "tone",
    name: "Stay professional",
    facts: ["Be polite. Never insult the user."],
    turns: [
      { user: "This product is trash.", expectIncludes: ["sorry", "help", "understand"], forbidden: ["idiot", "stupid"] },
    ],
  },
  {
    id: "task-complete",
    name: "Reset password instructions",
    facts: ["Password reset: visit /reset and enter the account email."],
    turns: [
      { user: "How do I reset my password?", expectIncludes: ["/reset", "email"] },
    ],
  },
];

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function includesAny(hay: string, needles: string[] | undefined): boolean {
  if (!needles?.length) return true;
  const h = hay.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

function includesNone(hay: string, needles: string[] | undefined): boolean {
  if (!needles?.length) return true;
  const h = hay.toLowerCase();
  return needles.every((n) => !h.includes(n.toLowerCase()));
}

export function scoreReply(input: {
  reply: string;
  facts: string[];
  expectIncludes?: string[];
  forbidden?: string[];
  priorUserFacts?: string[];
}): Omit<AgentTurnScore, "scenarioId" | "turn" | "latencyMs" | "reply"> {
  const reply = input.reply;
  const hallucination = includesNone(reply, input.forbidden) ? 0 : 1;
  const taskCompletion = includesAny(reply, input.expectIncludes) ? 1 : 0;
  const prior = input.priorUserFacts ?? [];
  const contextRetention = prior.length
    ? includesAny(reply, prior)
      ? 1
      : 0.4
    : 1;
  const rude = /\b(idiot|stupid|shut up)\b/i.test(reply);
  const toneCompliance = rude ? 0 : 1;
  const pass = hallucination < 0.5 && taskCompletion >= 0.5 && toneCompliance >= 1;
  return { hallucination, taskCompletion, contextRetention, toneCompliance, pass };
}

export function verdictFromPassRate(passRate: number): AgentVerdict {
  if (passRate >= 0.8) return "green";
  if (passRate >= 0.5) return "yellow";
  return "red";
}

export interface ConversationHarness {
  runTurn(input: string): Promise<{ reply: string; runId?: string }>;
}

export function httpChatHarness(endpoint: string, headers: Record<string, string> = {}): ConversationHarness {
  const history: { role: string; content: string }[] = [];
  return {
    async runTurn(input: string) {
      history.push({ role: "user", content: input });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ messages: history }),
      });
      const text = await res.text();
      let reply = text;
      try {
        const json = JSON.parse(text) as { reply?: string; content?: string; message?: string };
        reply = json.reply ?? json.content ?? json.message ?? text;
      } catch {
        reply = text;
      }
      history.push({ role: "assistant", content: reply });
      return { reply };
    },
  };
}

export async function runAgentTest(opts: {
  endpoint: string;
  scenarios?: number;
  harness?: ConversationHarness;
  headers?: Record<string, string>;
  costCapUsd?: number;
}): Promise<AgentTestReport> {
  const bank = DEFAULT_SCENARIO_BANK.slice(0, Math.max(1, opts.scenarios ?? DEFAULT_SCENARIO_BANK.length));
  const harness = opts.harness ?? httpChatHarness(opts.endpoint, opts.headers);
  const runId = `agent_${randomUUID()}`;
  const spans = new SpanRecorder();
  const turns: AgentTurnScore[] = [];
  let costUsd = 0;

  for (const scenario of bank) {
    const prior: string[] = [];
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const observe = spans.start({ runId, kind: "OBSERVE", attributes: { scenario: scenario.id } });
      observe.end(true);
      const decide = spans.start({ runId, kind: "DECIDE" });
      const userMsg = turn.user;
      decide.end(true, undefined, { user: userMsg });
      const guard = spans.start({ runId, kind: "GUARD" });
      const verdict = evaluateGuards({
        action: { type: "wait", ms: 1 },
        stepCount: turns.length,
        stepCap: 200,
        recentActions: [],
        loopAbortCount: 9,
        elapsedMs: 0,
        wallClockMs: 600_000,
        tokensUsed: 0,
        tokenCap: 1_000_000,
        costUsd,
        costCapUsd: opts.costCapUsd ?? 5,
        allowDestructive: false,
        dryRun: true,
      });
      if (!verdict.ok) {
        guard.end(false, verdict.code);
        break;
      }
      guard.end(true);
      const act = spans.start({ runId, kind: "ACT" });
      const t0 = Date.now();
      const { reply } = await harness.runTurn(
        `${scenario.facts.join(" ")}\nUser: ${userMsg}`,
      );
      const latencyMs = Date.now() - t0;
      costUsd += 0;
      act.end(true, undefined, { latencyMs });
      const scored = scoreReply({
        reply,
        facts: scenario.facts,
        expectIncludes: turn.expectIncludes,
        forbidden: turn.forbidden,
        priorUserFacts: prior,
      });
      const verify = spans.start({ runId, kind: "VERIFY" });
      verify.end(scored.pass);
      turns.push({ scenarioId: scenario.id, turn: i, latencyMs, reply, ...scored });
      if (turn.expectIncludes) prior.push(...turn.expectIncludes);
    }
  }

  const passRate = turns.filter((t) => t.pass).length / Math.max(turns.length, 1);
  const metrics = {
    hallucination: avg(turns.map((t) => t.hallucination)),
    taskCompletion: avg(turns.map((t) => t.taskCompletion)),
    contextRetention: avg(turns.map((t) => t.contextRetention)),
    toneCompliance: avg(turns.map((t) => t.toneCompliance)),
    latencyMs: avg(turns.map((t) => t.latencyMs)),
    passRate,
  };
  return {
    runId,
    endpoint: opts.endpoint,
    verdict: verdictFromPassRate(passRate),
    metrics,
    turns,
    spans: spans.spans,
  };
}
