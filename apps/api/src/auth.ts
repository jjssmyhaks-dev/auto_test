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
  /** Per-project monthly cost cap in USD; runs halt when exceeded. */
  costCapUsd?: number;
}

export interface ProjectRow {
  id: string;
  userId: string;
  name: string;
  /** Optional workspace this project belongs to. */
  workspaceId?: string;
  createdAt: string;
}

/** Role on a workspace (cross-project). Same ladder as project roles. */
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  viewer: 0,
};

/** A workspace groups projects; roles here apply across all its projects. */
export interface WorkspaceRow {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
}

/** A user's membership on a workspace they don't own. */
export interface WorkspaceMemberRow {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  addedBy: string;
  createdAt: string;
}

/** Cross-project role: the best of (workspace owner, workspace member row,
 *  project membership). Workspaces grant a FLOOR on every contained project. */
export function effectiveRole(
  wsRole: WorkspaceRole | undefined,
  projectRole: ProjectRole | undefined,
): ProjectRole | undefined {
  if (!wsRole) return projectRole;
  if (!projectRole) return wsRole;
  return ROLE_RANK[wsRole] >= ROLE_RANK[projectRole] ? wsRole : projectRole;
}

/** Role of a team member on a project. Owner is the creating account;
 *  admin manages members + destructive ops; member works; viewer reads. */
export type ProjectRole = "owner" | "admin" | "member" | "viewer";

export const ROLE_RANK: Record<ProjectRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

/** A user's membership on a project they don't (necessarily) own. */
export interface MemberRow {
  projectId: string;
  userId: string;
  role: ProjectRole;
  addedBy: string;
  createdAt: string;
}

/** Pending invitation: email + role, accepted with a one-time token. */
export interface InviteRow {
  id: string;
  projectId: string;
  email: string;
  role: ProjectRole;
  token: string;
  status: "pending" | "accepted" | "revoked";
  invitedBy: string;
  createdAt: string;
}

/** Pending invitation to a workspace (accepted via /v1/invites/accept). */
export interface WorkspaceInviteRow {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  status: "pending" | "accepted" | "revoked";
  invitedBy: string;
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
  /** Flow version this run executed. */
  flowVersion?: number;
  /** 1-based attempt number when a retry policy is active. */
  attempt?: number;
  /** Browser engine used. */
  browser?: "chromium" | "firefox" | "webkit";
  /** Steps repaired by self-heal. */
  healedSteps?: number;
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
  /** 5-field cron expression; absent = manual runs only. */
  schedule?: string;
  /** ISO timestamp of the last scheduled (claimed) run. */
  lastScheduledAt?: string;
  /** Retry policy for failed executions (suite + scheduled). */
  retryPolicy?: { maxAttempts: number; backoffSeconds: number };
  /** Quarantined flows are skipped by suites/schedules but runnable by hand. */
  quarantined?: boolean;
  /** Latest version number (monotonic per flow). */
  version?: number;
  /** Network route mocks applied before navigation. */
  routes?: Array<{ pattern: string; method?: string; status?: number; body?: string; contentType?: string; headers?: Record<string, string>; abort?: boolean }>;
}

/** Immutable snapshot of a flow at a point in time. */
export interface FlowVersionRow {
  id: string;
  flowId: string;
  projectId: string;
  version: number;
  name: string;
  objective: string;
  envUrl?: string;
  schedule?: string;
  routes?: FlowRow["routes"];
  /** Hash of the definition — cheap change detection + display. */
  changeHash: string;
  /** Run id of the most recent passing run on this version, when known. */
  lastGreenRunId?: string;
  createdBy: string;
  createdAt: string;
  /** Human note, e.g. "added OTP wait". */
  note?: string;
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

/** Outbound webhook endpoint (HMAC-signed delivery with retry). */
export interface WebhookRow {
  id: string;
  projectId: string;
  url: string;
  /** Secret used to sign deliveries (shown once at creation). */
  secret: string;
  events: string[];
  createdAt: string;
  disabled?: boolean;
  lastDeliveryAt?: string;
  lastDeliveryOk?: boolean;
}

/** Append-only audit trail of who did what. */
export interface AuditRow {
  id: string;
  projectId?: string;
  /** Acting user id (or "system" for scheduler/purges). */
  actor: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
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

/** Hosted device cloud: a registered machine (`veriflow device connect`)
 *  that polls for queued work. */
export interface DeviceRow {
  id: string;
  projectId: string;
  name: string;
  status: "online" | "offline";
  lastHeartbeatAt: string;
  createdAt: string;
}

/** A queued unit of work a device can claim (FIFO, one claimant). */
export interface DeviceJobRow {
  id: string;
  projectId: string;
  objective: string;
  envUrl?: string;
  status: "queued" | "claimed" | "done";
  claimedBy?: string;
  claimedAt?: string;
  resultRunId?: string;
  createdAt: string;
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
