import { z } from "zod";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "paused",
  "aborted",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const SpanKindSchema = z.enum([
  "OBSERVE",
  "DECIDE",
  "GUARD",
  "ACT",
  "VERIFY",
  "RETRY",
  "HUMAN",
]);
export type SpanKind = z.infer<typeof SpanKindSchema>;

export const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type BBox = z.infer<typeof BBoxSchema>;

export const TargetSchema = z.object({
  ref: z.string().optional(),
  bbox: BBoxSchema.optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
});
export type Target = z.infer<typeof TargetSchema>;

export const NavigateActionSchema = z.object({
  type: z.literal("navigate"),
  url: z.string().min(1),
});

export const ClickActionSchema = z.object({
  type: z.literal("click"),
  target: TargetSchema,
  destructive: z.boolean().optional(),
});

export const FillActionSchema = z.object({
  type: z.literal("fill"),
  target: TargetSchema,
  value: z.string(),
  secret: z.boolean().optional(),
  vaultKey: z.string().optional(),
});

export const SelectActionSchema = z.object({
  type: z.literal("select"),
  target: TargetSchema,
  value: z.string(),
});

export const HoverActionSchema = z.object({
  type: z.literal("hover"),
  target: TargetSchema,
});

export const ScrollActionSchema = z.object({
  type: z.literal("scroll"),
  target: TargetSchema.optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().optional(),
});

export const WaitActionSchema = z.object({
  type: z.literal("wait"),
  ms: z.number().int().nonnegative().optional(),
  selector: z.string().optional(),
});

export const AssertCheckSchema = z.enum([
  "visible",
  "text_contains",
  "url_contains",
  "heading_contains",
  "network",
  "console",
  "cookie_contains",
  "local_storage",
  "load_time_under",
]);
export type AssertCheck = z.infer<typeof AssertCheckSchema>;

export const AssertActionSchema = z.object({
  type: z.literal("assert"),
  check: AssertCheckSchema,
  value: z.string().optional(),
  target: TargetSchema.optional(),
});

export const FinishActionSchema = z.object({
  type: z.literal("finish"),
  success: z.boolean(),
  reason: z.string(),
});

export const RequestHumanActionSchema = z.object({
  type: z.literal("request_human"),
  reason: z.string(),
  prompt: z.string().optional(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  NavigateActionSchema,
  ClickActionSchema,
  FillActionSchema,
  SelectActionSchema,
  HoverActionSchema,
  ScrollActionSchema,
  WaitActionSchema,
  AssertActionSchema,
  FinishActionSchema,
  RequestHumanActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;

export const ActionTypes = [
  "navigate",
  "click",
  "fill",
  "select",
  "hover",
  "scroll",
  "wait",
  "assert",
  "finish",
  "request_human",
] as const;
export type ActionType = (typeof ActionTypes)[number];

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const FlowSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  name: z.string(),
  objective: z.string(),
  envUrl: z.string().optional(),
});
export type Flow = z.infer<typeof FlowSchema>;

export const SpanSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string().optional(),
  kind: SpanKindSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  ok: z.boolean().optional(),
  error: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
});
export type Span = z.infer<typeof SpanSchema>;

export const StepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  index: z.number().int().nonnegative(),
  action: ActionSchema,
  status: z.enum(["ok", "failed", "skipped", "retried"]),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  spans: z.array(SpanSchema).optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const RunSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  flowId: z.string().optional(),
  objective: z.string(),
  envUrl: z.string().optional(),
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().optional(),
  stepCount: z.number().int().nonnegative().default(0),
  tokenUsage: z
    .object({
      input: z.number(),
      output: z.number(),
    })
    .optional(),
  costUsd: z.number().optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const EvidenceFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
});

export const EvidenceManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  createdAt: z.string(),
  objective: z.string(),
  status: RunStatusSchema,
  envUrl: z.string().optional(),
  stepCount: z.number().int().nonnegative(),
  files: z.array(EvidenceFileSchema),
  tamperHash: z.string().optional(),
});
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export const RunEventTypeSchema = z.enum([
  "run_start",
  "run_end",
  "observe",
  "decide",
  "guard",
  "act",
  "verify",
  "retry",
  "human",
  "log",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z.object({
  ts: z.string(),
  type: RunEventTypeSchema,
  runId: z.string(),
  stepIndex: z.number().optional(),
  spanId: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const ConfigSchema = z.object({
  defaultEnvUrl: z.string().optional(),
  model: z.string().default("claude-sonnet-4-5"),
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  stepCap: z.number().int().positive().default(50),
  wallClockMs: z.number().int().positive().default(300_000),
  tokenCap: z.number().int().positive().default(200_000),
  costCapUsd: z.number().positive().default(5),
  loopAbortCount: z.number().int().positive().default(3),
  runCap: z.number().int().positive().default(100),
  captureDevtools: z.boolean().default(false),
  otlpExport: z.boolean().default(false),
  apiUrl: z.string().optional(),
  profiles: z
    .record(
      z.object({
        envUrl: z.string().optional(),
      }),
    )
    .optional(),
});
export type VeriflowConfig = z.infer<typeof ConfigSchema>;

export const BillingTierSchema = z.enum(["free", "starter", "team"]);
export type BillingTier = z.infer<typeof BillingTierSchema>;

export const TIER_QUOTAS: Record<BillingTier, { runsPerMonth: number; label: string }> = {
  free: { runsPerMonth: 50, label: "Free" },
  starter: { runsPerMonth: 500, label: "Starter" },
  team: { runsPerMonth: 5_000, label: "Team" },
};

export const UsageLedgerEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runId: z.string().optional(),
  kind: z.enum(["run", "llm"]),
  amount: z.number(),
  unit: z.enum(["run", "usd"]),
  createdAt: z.string(),
});
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntrySchema>;

export const AlertKindSchema = z.enum(["cost_spike", "success_rate"]);
export type AlertKind = z.infer<typeof AlertKindSchema>;

export const AlertSchema = z.object({
  kind: AlertKindSchema,
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  value: z.number().optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const CloudCredentialsSchema = z.object({
  apiUrl: z.string(),
  email: z.string().optional(),
  token: z.string(),
  projectId: z.string().optional(),
  apiKey: z.string().optional(),
});
export type CloudCredentials = z.infer<typeof CloudCredentialsSchema>;

export const AgentVerdictSchema = z.enum(["green", "yellow", "red"]);
export type AgentVerdict = z.infer<typeof AgentVerdictSchema>;

export function parseAction(input: unknown): Action {
  return ActionSchema.parse(input);
}

export function safeParseAction(input: unknown) {
  return ActionSchema.safeParse(input);
}

export function quotaForTier(tier: BillingTier): number {
  return TIER_QUOTAS[tier].runsPerMonth;
}
