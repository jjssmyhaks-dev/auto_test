import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { BillingTier } from "@veriflow/schema";

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = scryptSync(password, salt, 32);
  const a = Buffer.from(hash, "hex");
  if (a.length !== check.length) return false;
  return timingSafeEqual(a, check);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(prefix = "vf"): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  tier: BillingTier;
  createdAt: string;
}

export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  projectId: string;
  name: string;
  keyHash: string;
  prefix: string;
  createdAt: string;
}

export interface SessionRow {
  tokenHash: string;
  userId: string;
  createdAt: string;
}

export interface RunRow {
  id: string;
  projectId: string;
  flowId?: string;
  objective: string;
  envUrl?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  stepCount: number;
  costUsd?: number;
  error?: string;
  events?: unknown;
}

export interface StepRow {
  id: string;
  runId: string;
  index: number;
  action: unknown;
  status: string;
  startedAt: string;
  endedAt?: string;
}

export interface SpanRow {
  id: string;
  runId: string;
  stepId?: string;
  kind: string;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  error?: string;
  attributes?: Record<string, unknown>;
}

export interface UsageRow {
  id: string;
  projectId: string;
  runId?: string;
  kind: "run" | "llm";
  amount: number;
  unit: "run" | "usd";
  createdAt: string;
}

export interface FlowRow {
  id: string;
  projectId: string;
  name: string;
  objective: string;
  envUrl?: string;
}

export interface AlertRuleRow {
  id: string;
  projectId: string;
  metric: "success_rate" | "cost_spike";
  threshold: number;
  channel: string;
  createdAt: string;
  lastTriggeredAt?: string;
}

export interface HumanPauseRow {
  id: string;
  runId: string;
  projectId: string;
  reason: string;
  prompt?: string;
  status: "pending" | "resolved" | "expired";
  response?: string;
  createdAt: string;
  resolvedAt?: string;
  expiresAt: string;
}

/** Per-user UI progress (onboarding checklist, guided tour) so it follows
 *  the account across devices instead of living only in localStorage. */
export interface UserProgressRow {
  userId: string;
  /** Completed onboarding actions, e.g. "queue_run". */
  onboardingDone: string[];
  onboardingDismissed: boolean;
  /** Guided tour: last visited step index; absent once cleanly finished. */
  tourStep?: number;
  tourMode?: "guided" | "interactive";
  updatedAt: string;
}

/** Spec §4: precomputed per-flow/project metrics so the dashboard never
 *  scans raw spans on page load. Two windows: trailing 7 and 30 days. */
export interface MetricRollupRow {
  id: string;
  projectId: string;
  flowId: string;
  windowDays: 7 | 30;
  computedAt: string;
  runs: number;
  successRate: number;
  medianSteps: number;
  avgCostUsd: number;
  selfHealRate: number;
  humanInterventionRate: number;
  guardAbortRate: number;
}

export interface AuthContext {
  user: UserRow;
  project?: ProjectRow;
  via: "session" | "api_key";
}
