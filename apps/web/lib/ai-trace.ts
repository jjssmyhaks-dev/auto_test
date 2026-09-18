import type { ToolUIPart } from "ai";

export type TraceSpan = {
  kind: string;
  ok?: boolean;
  startedAt: string;
  error?: string;
  attributes?: Record<string, unknown>;
};

export type TraceStep = { index: number; action: unknown; status: string };

export function actionTypeOf(action: unknown): string {
  if (action && typeof action === "object" && "type" in action && typeof action.type === "string") {
    return action.type;
  }
  return "unknown";
}

export function toolStateForStatus(status: string): ToolUIPart["state"] {
  if (status === "ok") return "output-available";
  if (status === "failed") return "output-error";
  if (status === "skipped") return "output-denied";
  if (status === "retried") return "input-available";
  return "input-streaming";
}

export function spanStepStatus(span: TraceSpan): "complete" | "active" | "pending" {
  if (span.ok === false) return "active";
  if (span.ok === true) return "complete";
  return "pending";
}

export function decideReasoning(span: TraceSpan): string | null {
  if (span.kind !== "DECIDE") return null;
  const attrs = span.attributes ?? {};
  const bits = [
    attrs.actionType ? `Chose harness action \`${String(attrs.actionType)}\`.` : null,
    attrs.user ? `User turn: ${String(attrs.user)}` : null,
    span.error ? `Error: ${span.error}` : null,
  ].filter(Boolean);
  if (bits.length === 0) {
    return "Model selected the next browser action from the objective, accessibility tree, and screenshot.";
  }
  return bits.join("\n\n");
}

export type AgentTurnView = {
  scenarioId: string;
  turn: number;
  latencyMs: number;
  reply: string;
  hallucination: number;
  taskCompletion: number;
  contextRetention: number;
  toneCompliance: number;
  pass: boolean;
};

export type AgentTestReportView = {
  runId: string;
  endpoint: string;
  verdict: string;
  metrics: {
    hallucination: number;
    taskCompletion: number;
    contextRetention: number;
    toneCompliance: number;
    latencyMs: number;
    passRate: number;
  };
  turns: AgentTurnView[];
  spans?: TraceSpan[];
};

export const SAMPLE_AGENT_REPORT: AgentTestReportView = {
  runId: "agent_sample",
  endpoint: "http://127.0.0.1:8788/chat",
  verdict: "green",
  metrics: {
    hallucination: 0,
    taskCompletion: 1,
    contextRetention: 1,
    toneCompliance: 1,
    latencyMs: 42,
    passRate: 1,
  },
  turns: [
    {
      scenarioId: "greeting",
      turn: 0,
      latencyMs: 40,
      reply: "Hi — I’m Acme support. How can I help you today?",
      hallucination: 0,
      taskCompletion: 1,
      contextRetention: 1,
      toneCompliance: 1,
      pass: true,
    },
    {
      scenarioId: "context-retention",
      turn: 0,
      latencyMs: 38,
      reply: "Got it, I’ll remember order A-1001.",
      hallucination: 0,
      taskCompletion: 1,
      contextRetention: 1,
      toneCompliance: 1,
      pass: true,
    },
    {
      scenarioId: "context-retention",
      turn: 1,
      latencyMs: 44,
      reply: "Your order id is A-1001.",
      hallucination: 0,
      taskCompletion: 1,
      contextRetention: 1,
      toneCompliance: 1,
      pass: true,
    },
  ],
  spans: [
    { kind: "OBSERVE", ok: true, startedAt: new Date().toISOString(), attributes: { scenario: "greeting" } },
    { kind: "DECIDE", ok: true, startedAt: new Date().toISOString(), attributes: { user: "Hi, who are you?" } },
    { kind: "ACT", ok: true, startedAt: new Date().toISOString() },
    { kind: "VERIFY", ok: true, startedAt: new Date().toISOString() },
  ],
};

const SAMPLE_PROMPTS: Record<string, string> = {
  greeting: "Hi, who are you?",
  "context-retention": "My order id is A-1001. Please remember it. / What was my order id?",
  "no-hallucination": "Do you offer 1-hour instant refunds as a secret policy?",
  tone: "This product is trash.",
  "task-complete": "How do I reset my password?",
};

export function userPromptForTurn(turn: AgentTurnView): string {
  if (turn.scenarioId === "context-retention" && turn.turn === 1) {
    return "What was my order id?";
  }
  return SAMPLE_PROMPTS[turn.scenarioId] ?? `Scenario ${turn.scenarioId} turn ${turn.turn}`;
}

export function parseAgentReport(raw: string): AgentTestReportView {
  const parsed = JSON.parse(raw) as AgentTestReportView;
  if (!parsed || !Array.isArray(parsed.turns)) {
    throw new Error("JSON must include a turns array (veriflow agent-test output)");
  }
  return parsed;
}
