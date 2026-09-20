import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cronMatches, parseCron } from "@veriflow/harness";
import { join } from "node:path";
import { TIER_QUOTAS, type BillingTier } from "@veriflow/schema";
import {
  hashToken,
  newId,
  ROLE_RANK,
  type AlertRuleRow,
  type ApiKeyRow,
  type DeviceJobRow,
  type DeviceRow,
  type FlowRow,
  type HumanPauseRow,
  type InviteRow,
  type MemberRow,
  type MetricRollupRow,
  type ProjectRole,
  type ProjectRow,
  type RunRow,
  type SessionRow,
  type SpanRow,
  type StepRow,
  type UsageRow,
  type UserProgressRow,
  type UserRow,
  type WorkspaceInviteRow,
  type WorkspaceMemberRow,
  type WorkspaceRole,
  type WorkspaceRow,
  effectiveRole,
} from "./auth.js";

export interface CloudStore {
  createUser(email: string, passwordHash: string): Promise<UserRow>;
  getUserByEmail(email: string): Promise<UserRow | undefined>;
  getUser(id: string): Promise<UserRow | undefined>;
  setTier(userId: string, tier: BillingTier): Promise<UserRow | undefined>;
  createSession(userId: string, tokenHash: string): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRow | undefined>;
  /** Remove sessions older than the TTL; returns how many were purged. */
  purgeExpiredSessions(): Promise<number>;
  createProject(userId: string, name: string): Promise<ProjectRow>;
  listProjects(userId: string): Promise<ProjectRow[]>;
  getProject(id: string): Promise<ProjectRow | undefined>;
  // Workspaces: a layer above projects. A workspace role acts as a FLOOR on
  // every project inside it; per-project roles can still grant more.
  createWorkspace(userId: string, name: string): Promise<WorkspaceRow>;
  listWorkspaces(userId: string): Promise<WorkspaceRow[]>;
  getWorkspace(id: string): Promise<WorkspaceRow | undefined>;
  addWorkspaceMember(row: WorkspaceMemberRow): Promise<WorkspaceMemberRow>;
  listWorkspaceMembers(workspaceId: string): Promise<(WorkspaceMemberRow & { email?: string })[]>;
  removeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean>;
  setWorkspaceMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMemberRow | undefined>;
  // Workspace invites: one-time tokens, accepted via /v1/invites/accept.
  createWorkspaceInvite(row: WorkspaceInviteRow): Promise<WorkspaceInviteRow>;
  getWorkspaceInviteByToken(token: string): Promise<WorkspaceInviteRow | undefined>;
  acceptWorkspaceInvite(token: string, userId: string): Promise<WorkspaceInviteRow | undefined>;
  /** Cross-project role: workspace floor combined with the project role. */
  effectiveRoleFor(projectId: string, userId: string): Promise<ProjectRole | undefined>;
  /** Attach (or detach with undefined) a project to a workspace. */
  setProjectWorkspace(projectId: string, workspaceId: string | undefined): Promise<ProjectRow | undefined>;
  // Team roles: explicit membership with per-project roles. `roleFor` returns
  // the best of (project owner, member row) — existing single-user projects
  // keep working as owner without backfill.
  addMember(row: MemberRow): Promise<MemberRow>;
  listMembers(projectId: string): Promise<(MemberRow & { email?: string })[]>;
  removeMember(projectId: string, userId: string): Promise<boolean>;
  setMemberRole(projectId: string, userId: string, role: ProjectRole): Promise<MemberRow | undefined>;
  roleFor(projectId: string, userId: string): Promise<ProjectRole | undefined>;
  /** All membership rows for a user (projects they belong to but don't own). */
  listMemberships(userId: string): Promise<MemberRow[]>;
  createInvite(row: InviteRow): Promise<InviteRow>;
  listInvites(projectId: string): Promise<InviteRow[]>;
  getInviteByToken(token: string): Promise<InviteRow | undefined>;
  acceptInvite(token: string, userId: string): Promise<{ invite: InviteRow; member: MemberRow } | undefined>;
  revokeInvite(projectId: string, inviteId: string): Promise<boolean>;
  findUserByEmail(email: string): Promise<UserRow | undefined>;
  createApiKey(row: ApiKeyRow): Promise<ApiKeyRow>;
  listApiKeys(projectId: string): Promise<ApiKeyRow[]>;
  findApiKey(keyHash: string): Promise<ApiKeyRow | undefined>;
  upsertRun(row: RunRow): Promise<RunRow>;
  getRun(id: string): Promise<RunRow | undefined>;
  listRuns(projectId: string): Promise<RunRow[]>;
  replaceSteps(runId: string, steps: StepRow[]): Promise<void>;
  listSteps(runId: string): Promise<StepRow[]>;
  replaceSpans(runId: string, spans: SpanRow[]): Promise<void>;
  listSpans(runId: string): Promise<SpanRow[]>;
  addUsage(row: UsageRow): Promise<void>;
  listUsage(projectId: string): Promise<UsageRow[]>;
  /** Usage across every project of a workspace (for the rollup endpoint). */
  listUsageByWorkspace(workspaceId: string): Promise<(UsageRow & { projectId: string })[]>;
  monthlyRunCount(projectId: string, monthStartIso: string): Promise<number>;
  saveFlow(row: FlowRow): Promise<FlowRow>;
  listFlows(projectId: string): Promise<FlowRow[]>;
  /** Scheduling: claim all flows whose cron is due — atomically per flow.
   *  Returns (flowId, name, objective, envUrl) for the scheduler to execute. */
  claimDueFlows(projectId: string, now: Date): Promise<{ flowId: string; name: string; objective: string; envUrl?: string; schedule: string }[]>;
  listAllRuns(): Promise<RunRow[]>;
  saveAlertRule(rule: AlertRuleRow): Promise<AlertRuleRow>;
  listAlertRules(projectId: string): Promise<AlertRuleRow[]>;
  deleteAlertRule(projectId: string, ruleId: string): Promise<boolean>;
  markAlertTriggered(ruleId: string, at: string): Promise<void>;
  createHumanPause(pause: HumanPauseRow): Promise<HumanPauseRow>;
  listHumanPauses(projectId: string): Promise<HumanPauseRow[]>;
  getHumanPause(id: string): Promise<HumanPauseRow | undefined>;
  resolveHumanPause(id: string, response: string): Promise<HumanPauseRow | undefined>;
  replaceMetricRollups(projectId: string, rollups: MetricRollupRow[]): Promise<void>;
  listMetricRollups(projectId: string, flowId?: string): Promise<MetricRollupRow[]>;
  getUserProgress(userId: string): Promise<UserProgressRow | undefined>;
  saveUserProgress(row: UserProgressRow): Promise<UserProgressRow>;
  deleteUserProgress(userId: string): Promise<boolean>;
  listAllUserProgress(): Promise<UserProgressRow[]>;
  // Hosted device cloud.
  saveDevice(row: DeviceRow): Promise<DeviceRow>;
  listDevices(projectId: string): Promise<DeviceRow[]>;
  getDevice(id: string): Promise<DeviceRow | undefined>;
  heartbeatDevice(id: string, status: "online" | "offline"): Promise<DeviceRow | undefined>;
  queueDeviceJob(row: DeviceJobRow): Promise<DeviceJobRow>;
  listDeviceJobs(projectId: string): Promise<DeviceJobRow[]>;
  /** FIFO claim for a device; also flips device status online. */
  claimDeviceJob(deviceId: string): Promise<DeviceJobRow | undefined>;
  completeDeviceJob(id: string, resultRunId: string): Promise<DeviceJobRow | undefined>;
  /** Demo reset: drop every run/step/span/flow/rule/ledger row for a project.
   *  Returns the counts removed so the response can show what was cleared. */
  clearProjectData(projectId: string): Promise<{ runs: number; flows: number; alertRules: number; usage: number }>;
}

interface FileDb {
  users: UserRow[];
  sessions: SessionRow[];
  projects: ProjectRow[];
  members: MemberRow[];
  invites: InviteRow[];
  workspaces: WorkspaceRow[];
  workspaceMembers: WorkspaceMemberRow[];
  workspaceInvites: WorkspaceInviteRow[];
  keys: ApiKeyRow[];
  runs: RunRow[];
  steps: StepRow[];
  spans: SpanRow[];
  usage: UsageRow[];
  flows: FlowRow[];
  alertRules: AlertRuleRow[];
  humanPauses: HumanPauseRow[];
  metricRollups: MetricRollupRow[];
  userProgress: UserProgressRow[];
  devices: DeviceRow[];
  deviceJobs: DeviceJobRow[];
}

function emptyDb(): FileDb {
  return {
    users: [],
    sessions: [],
    projects: [],
    members: [],
    invites: [],
    workspaces: [],
    workspaceMembers: [],
    workspaceInvites: [],
    keys: [],
    runs: [],
    steps: [],
    spans: [],
    usage: [],
    flows: [],
    alertRules: [],
    humanPauses: [],
    metricRollups: [],
    userProgress: [],
    devices: [],
    deviceJobs: [],
  };
}

export class MemoryStore implements CloudStore {
  constructor(private db: FileDb = emptyDb(), private persist?: () => void) {}

  static fromFile(dir: string): MemoryStore {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "cloud.json");
    let db = emptyDb();
    if (existsSync(file)) {
      try {
        db = { ...emptyDb(), ...(JSON.parse(readFileSync(file, "utf8")) as FileDb) };
      } catch {
        db = emptyDb();
      }
    }
    const store = new MemoryStore(db, () => {
      writeFileSync(file, JSON.stringify(store.db, null, 2), "utf8");
    });
    return store;
  }

  private touch() {
    this.persist?.();
  }

  async createUser(email: string, passwordHash: string): Promise<UserRow> {
    const existing = this.db.users.find((u) => u.email === email.toLowerCase());
    if (existing) throw Object.assign(new Error("email already registered"), { status: 409 });
    const row: UserRow = {
      id: newId("usr"),
      email: email.toLowerCase(),
      passwordHash,
      tier: "free",
      createdAt: new Date().toISOString(),
    };
    this.db.users.push(row);
    this.touch();
    return row;
  }
  async getUserByEmail(email: string) {
    return this.db.users.find((u) => u.email === email.toLowerCase());
  }
  async getUser(id: string) {
    return this.db.users.find((u) => u.id === id);
  }
  async setTier(userId: string, tier: BillingTier) {
    const u = this.db.users.find((x) => x.id === userId);
    if (!u) return undefined;
    u.tier = tier;
    this.touch();
    return u;
  }
  async createSession(userId: string, tokenHash: string) {
    this.db.sessions.push({ tokenHash, userId, createdAt: new Date().toISOString() });
    this.touch();
  }
  async getSession(tokenHash: string) {
    const session = this.db.sessions.find((s) => s.tokenHash === tokenHash);
    if (!session) return undefined;
    // Expiry: 30 days sliding window from creation.
    if (Date.now() - Date.parse(session.createdAt) > SESSION_TTL_MS) {
      this.db.sessions = this.db.sessions.filter((s) => s.tokenHash !== tokenHash);
      this.touch();
      return undefined;
    }
    return session;
  }
  /** Purge expired sessions (call opportunistically); returns count removed. */
  async purgeExpiredSessions() {
    const before = this.db.sessions.length;
    this.db.sessions = this.db.sessions.filter((s) => Date.now() - Date.parse(s.createdAt) <= SESSION_TTL_MS);
    const removed = before - this.db.sessions.length;
    if (removed > 0) this.touch();
    return removed;
  }
  async createProject(userId: string, name: string) {
    const row: ProjectRow = { id: newId("prj"), userId, name, createdAt: new Date().toISOString() };
    this.db.projects.push(row);
    this.touch();
    return row;
  }
  async listProjects(userId: string) {
    return this.db.projects.filter((p) => p.userId === userId);
  }
  async getProject(id: string) {
    return this.db.projects.find((p) => p.id === id);
  }
  async addMember(row: MemberRow) {
    const i = this.db.members.findIndex((m) => m.projectId === row.projectId && m.userId === row.userId);
    if (i >= 0) this.db.members[i] = row;
    else this.db.members.push(row);
    this.touch();
    return row;
  }
  async listMembers(projectId: string) {
    return this.db.members
      .filter((m) => m.projectId === projectId)
      .map((m) => ({ ...m, email: this.db.users.find((u) => u.id === m.userId)?.email }));
  }
  async removeMember(projectId: string, userId: string) {
    const before = this.db.members.length;
    this.db.members = this.db.members.filter((m) => !(m.projectId === projectId && m.userId === userId));
    const removed = before > this.db.members.length;
    if (removed) this.touch();
    return removed;
  }
  async setMemberRole(projectId: string, userId: string, role: ProjectRole) {
    const m = this.db.members.find((m) => m.projectId === projectId && m.userId === userId);
    if (!m) return undefined;
    m.role = role;
    this.touch();
    return m;
  }
  async roleFor(projectId: string, userId: string) {
    const project = this.db.projects.find((p) => p.id === projectId);
    if (project && project.userId === userId) return "owner";
    const member = this.db.members.find((m) => m.projectId === projectId && m.userId === userId);
    return member?.role;
  }
  async effectiveRoleFor(projectId: string, userId: string) {
    const projectRole = await this.roleFor(projectId, userId);
    const project = this.db.projects.find((p) => p.id === projectId);
    let wsRole: WorkspaceRole | undefined;
    if (project?.workspaceId) {
      const ws = this.db.workspaces.find((w) => w.id === project.workspaceId);
      if (ws) {
        if (ws.userId === userId) wsRole = "owner";
        else wsRole = this.db.workspaceMembers.find((m) => m.workspaceId === ws.id && m.userId === userId)?.role;
      }
    }
    return effectiveRole(wsRole, projectRole);
  }
  async listMemberships(userId: string) {
    return this.db.members.filter((m) => m.userId === userId);
  }
  async createWorkspace(userId: string, name: string): Promise<WorkspaceRow> {
    const ws: WorkspaceRow = {
      id: newId("ws"),
      userId,
      name,
      createdAt: new Date().toISOString(),
    };
    this.db.workspaces.push(ws);
    this.touch();
    return ws;
  }
  async listWorkspaces(userId: string) {
    const memberOf = new Set(
      this.db.workspaceMembers.filter((m) => m.userId === userId).map((m) => m.workspaceId),
    );
    return this.db.workspaces.filter((w) => w.userId === userId || memberOf.has(w.id));
  }
  async getWorkspace(id: string) {
    return this.db.workspaces.find((w) => w.id === id);
  }
  async addWorkspaceMember(row: WorkspaceMemberRow) {
    this.db.workspaceMembers = this.db.workspaceMembers.filter(
      (m) => !(m.workspaceId === row.workspaceId && m.userId === row.userId),
    );
    this.db.workspaceMembers.push(row);
    this.touch();
    return row;
  }
  async listWorkspaceMembers(workspaceId: string) {
    return this.db.workspaceMembers
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => ({ ...m, email: this.db.users.find((u) => u.id === m.userId)?.email }));
  }
  async removeWorkspaceMember(workspaceId: string, userId: string) {
    const before = this.db.workspaceMembers.length;
    this.db.workspaceMembers = this.db.workspaceMembers.filter(
      (m) => !(m.workspaceId === workspaceId && m.userId === userId),
    );
    const removed = before > this.db.workspaceMembers.length;
    if (removed) this.touch();
    return removed;
  }
  async setWorkspaceMemberRole(workspaceId: string, userId: string, role: WorkspaceRole) {
    const m = this.db.workspaceMembers.find(
      (m) => m.workspaceId === workspaceId && m.userId === userId,
    );
    if (!m) return undefined;
    m.role = role;
    this.touch();
    return m;
  }
  async createWorkspaceInvite(row: WorkspaceInviteRow) {
    this.db.workspaceInvites.push(row);
    this.touch();
    return row;
  }
  async getWorkspaceInviteByToken(token: string) {
    return this.db.workspaceInvites.find((i) => i.token === token && i.status === "pending");
  }
  async acceptWorkspaceInvite(token: string, userId: string) {
    const invite = this.db.workspaceInvites.find((i) => i.token === token && i.status === "pending");
    if (!invite) return undefined;
    invite.status = "accepted";
    const existing = this.db.workspaceMembers.find(
      (m) => m.workspaceId === invite.workspaceId && m.userId === userId,
    );
    if (existing) existing.role = invite.role;
    else
      this.db.workspaceMembers.push({
        workspaceId: invite.workspaceId,
        userId,
        role: invite.role,
        addedBy: invite.invitedBy,
        createdAt: new Date().toISOString(),
      });
    this.touch();
    return invite;
  }
  async setProjectWorkspace(projectId: string, workspaceId: string | undefined) {
    const p = this.db.projects.find((p) => p.id === projectId);
    if (!p) return undefined;
    p.workspaceId = workspaceId;
    this.touch();
    return p;
  }
  async createInvite(row: InviteRow) {
    this.db.invites.push(row);
    this.touch();
    return row;
  }
  async listInvites(projectId: string) {
    return this.db.invites.filter((i) => i.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getInviteByToken(token: string) {
    return this.db.invites.find((i) => i.token === token && i.status === "pending");
  }
  async acceptInvite(token: string, userId: string) {
    const invite = this.db.invites.find((i) => i.token === token && i.status === "pending");
    if (!invite) return undefined;
    invite.status = "accepted";
    const existing = this.db.members.find((m) => m.projectId === invite.projectId && m.userId === userId);
    const member: MemberRow =
      existing ?? {
        projectId: invite.projectId,
        userId,
        role: invite.role,
        addedBy: invite.invitedBy,
        createdAt: new Date().toISOString(),
      };
    if (existing) existing.role = invite.role;
    else this.db.members.push(member);
    this.touch();
    return { invite, member };
  }
  async revokeInvite(projectId: string, inviteId: string) {
    const invite = this.db.invites.find((i) => i.id === inviteId && i.projectId === projectId);
    if (!invite) return false;
    invite.status = "revoked";
    this.touch();
    return true;
  }
  async findUserByEmail(email: string) {
    const needle = email.trim().toLowerCase();
    return this.db.users.find((u) => u.email.toLowerCase() === needle);
  }
  async createApiKey(row: ApiKeyRow) {
    this.db.keys.push(row);
    this.touch();
    return row;
  }
  async listApiKeys(projectId: string) {
    return this.db.keys.filter((k) => k.projectId === projectId);
  }
  async findApiKey(keyHash: string) {
    return this.db.keys.find((k) => k.keyHash === keyHash);
  }
  async upsertRun(row: RunRow) {
    const i = this.db.runs.findIndex((r) => r.id === row.id);
    if (i >= 0) this.db.runs[i] = row;
    else this.db.runs.push(row);
    this.touch();
    return row;
  }
  async getRun(id: string) {
    return this.db.runs.find((r) => r.id === id);
  }
  async listRuns(projectId: string) {
    return this.db.runs.filter((r) => r.projectId === projectId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async replaceSteps(runId: string, steps: StepRow[]) {
    this.db.steps = this.db.steps.filter((s) => s.runId !== runId).concat(steps);
    this.touch();
  }
  async listSteps(runId: string) {
    return this.db.steps.filter((s) => s.runId === runId).sort((a, b) => a.index - b.index);
  }
  async replaceSpans(runId: string, spans: SpanRow[]) {
    this.db.spans = this.db.spans.filter((s) => s.runId !== runId).concat(spans);
    this.touch();
  }
  async listSpans(runId: string) {
    return this.db.spans.filter((s) => s.runId === runId);
  }
  async addUsage(row: UsageRow) {
    this.db.usage.push(row);
    this.touch();
  }
  async listUsage(projectId: string) {
    return this.db.usage.filter((u) => u.projectId === projectId);
  }
  async listUsageByWorkspace(workspaceId: string) {
    const projectIds = new Set(
      this.db.projects.filter((p) => p.workspaceId === workspaceId).map((p) => p.id),
    );
    return this.db.usage.filter((u) => projectIds.has(u.projectId));
  }
  async monthlyRunCount(projectId: string, monthStartIso: string) {
    return this.db.usage.filter(
      (u) => u.projectId === projectId && u.kind === "run" && u.createdAt >= monthStartIso,
    ).length;
  }
  async saveFlow(row: FlowRow) {
    const i = this.db.flows.findIndex((f) => f.id === row.id);
    if (i >= 0) this.db.flows[i] = row;
    else this.db.flows.push(row);
    this.touch();
    return row;
  }
  async listFlows(projectId: string) {
    return this.db.flows.filter((f) => f.projectId === projectId);
  }
  async claimDueFlows(projectId: string, now: Date) {
    const due: { flowId: string; name: string; objective: string; envUrl?: string; schedule: string }[] = [];
    for (const flow of this.db.flows) {
      if (flow.projectId !== projectId || !flow.schedule) continue;
      let matches = false;
      try {
        matches = cronMatches(parseCron(flow.schedule), now);
      } catch {
        continue; // invalid stored expression — skip, never crash the scheduler
      }
      if (!matches) continue;
      // Claim once per matching minute.
      if (flow.lastScheduledAt === now.toISOString()) continue;
      flow.lastScheduledAt = now.toISOString();
      due.push({ flowId: flow.id, name: flow.name, objective: flow.objective, envUrl: flow.envUrl, schedule: flow.schedule });
    }
    this.touch();
    return due;
  }
  async saveDevice(row: DeviceRow) {
    const i = this.db.devices.findIndex((d) => d.id === row.id);
    if (i >= 0) this.db.devices[i] = row;
    else this.db.devices.push(row);
    this.touch();
    return row;
  }
  async listDevices(projectId: string) {
    return this.db.devices.filter((d) => d.projectId === projectId);
  }
  async getDevice(id: string) {
    return this.db.devices.find((d) => d.id === id);
  }
  async heartbeatDevice(id: string, status: "online" | "offline") {
    const d = this.db.devices.find((x) => x.id === id);
    if (!d) return undefined;
    d.status = status;
    d.lastHeartbeatAt = new Date().toISOString();
    this.touch();
    return d;
  }
  async queueDeviceJob(row: DeviceJobRow) {
    this.db.deviceJobs.push(row);
    this.touch();
    return row;
  }
  async listDeviceJobs(projectId: string) {
    return this.db.deviceJobs.filter((j) => j.projectId === projectId);
  }
  async claimDeviceJob(deviceId: string) {
    const device = this.db.devices.find((d) => d.id === deviceId);
    if (!device) return undefined;
    device.status = "online";
    device.lastHeartbeatAt = new Date().toISOString();
    const job = this.db.deviceJobs.find((j) => j.projectId === device.projectId && j.status === "queued");
    if (!job) {
      this.touch();
      return undefined;
    }
    job.status = "claimed";
    job.claimedBy = deviceId;
    job.claimedAt = new Date().toISOString();
    this.touch();
    return job;
  }
  async completeDeviceJob(id: string, resultRunId: string) {
    const job = this.db.deviceJobs.find((j) => j.id === id);
    if (!job) return undefined;
    job.status = "done";
    job.resultRunId = resultRunId;
    this.touch();
    return job;
  }
  async listAllRuns() {
    return this.db.runs;
  }
  async saveAlertRule(rule: AlertRuleRow) {
    const i = this.db.alertRules.findIndex((r) => r.id === rule.id);
    if (i >= 0) this.db.alertRules[i] = rule;
    else this.db.alertRules.push(rule);
    this.persist?.();
    return rule;
  }
  async listAlertRules(projectId: string) {
    return this.db.alertRules.filter((r) => r.projectId === projectId);
  }
  async deleteAlertRule(projectId: string, ruleId: string) {
    const i = this.db.alertRules.findIndex((r) => r.id === ruleId && r.projectId === projectId);
    if (i < 0) return false;
    this.db.alertRules.splice(i, 1);
    this.persist?.();
    return true;
  }
  async markAlertTriggered(ruleId: string, at: string) {
    const rule = this.db.alertRules.find((r) => r.id === ruleId);
    if (rule) {
      rule.lastTriggeredAt = at;
      this.persist?.();
    }
  }
  async createHumanPause(pause: HumanPauseRow) {
    this.db.humanPauses.push(pause);
    this.persist?.();
    return pause;
  }
  async listHumanPauses(projectId: string) {
    return this.db.humanPauses
      .filter((p) => p.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async getHumanPause(id: string) {
    const pause = this.db.humanPauses.find((p) => p.id === id);
    if (pause && pause.status === "pending" && pause.expiresAt < new Date().toISOString()) {
      pause.status = "expired";
      this.persist?.();
    }
    return pause;
  }
  async resolveHumanPause(id: string, response: string) {
    const pause = this.db.humanPauses.find((p) => p.id === id);
    if (!pause || pause.status !== "pending") return undefined;
    pause.status = "resolved";
    pause.response = response;
    pause.resolvedAt = new Date().toISOString();
    this.persist?.();
    return pause;
  }
  async replaceMetricRollups(projectId: string, rollups: MetricRollupRow[]) {
    this.db.metricRollups = this.db.metricRollups.filter((r) => r.projectId !== projectId).concat(rollups);
    this.persist?.();
  }
  async listMetricRollups(projectId: string, flowId?: string) {
    return this.db.metricRollups
      .filter((r) => r.projectId === projectId && (!flowId || r.flowId === flowId))
      .sort((a, b) => (a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : a.windowDays - b.windowDays));
  }
  async getUserProgress(userId: string) {
    return this.db.userProgress.find((p) => p.userId === userId);
  }
  async saveUserProgress(row: UserProgressRow) {
    const i = this.db.userProgress.findIndex((p) => p.userId === row.userId);
    if (i >= 0) this.db.userProgress[i] = row;
    else this.db.userProgress.push(row);
    this.touch();
    return row;
  }
  async deleteUserProgress(userId: string) {
    const before = this.db.userProgress.length;
    this.db.userProgress = this.db.userProgress.filter((p) => p.userId !== userId);
    this.touch();
    return this.db.userProgress.length < before;
  }
  async listAllUserProgress() {
    return [...this.db.userProgress];
  }
  async clearProjectData(projectId: string) {
    const runsBefore = this.db.runs.filter((r) => r.projectId === projectId);
    const runIds = new Set(runsBefore.map((r) => r.id));
    const result = {
      runs: runsBefore.length,
      flows: this.db.flows.filter((f) => f.projectId === projectId).length,
      alertRules: this.db.alertRules.filter((r) => r.projectId === projectId).length,
      usage: this.db.usage.filter((u) => u.projectId === projectId).length,
    };
    this.db.runs = this.db.runs.filter((r) => r.projectId !== projectId);
    this.db.steps = this.db.steps.filter((s) => !runIds.has(s.runId));
    this.db.spans = this.db.spans.filter((s) => !runIds.has(s.runId));
    this.db.flows = this.db.flows.filter((f) => f.projectId !== projectId);
    this.db.alertRules = this.db.alertRules.filter((r) => r.projectId !== projectId);
    this.db.usage = this.db.usage.filter((u) => u.projectId !== projectId);
    this.touch();
    return result;
  }
}

export const QUOTAS = TIER_QUOTAS;

/** Session lifetime: 30 days. `getSession` enforces it lazily;
 *  `purgeExpiredSessions` reclaims the rows. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Fixed-window rate limiter (in-memory, per key). */
const rateWindows = new Map<string, { count: number; resetAt: number }>();
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const w = rateWindows.get(key);
  if (!w || w.resetAt <= now) {
    rateWindows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  w.count++;
  if (w.count > limit) return { ok: false, retryAfter: Math.ceil((w.resetAt - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}
/** Test hook: clear all rate-limit windows. */
export function resetRateLimits() {
  rateWindows.clear();
}

export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function computeAlerts(runs: RunRow[]): { kind: "cost_spike" | "success_rate"; severity: string; message: string; value: number }[] {
  const alerts: { kind: "cost_spike" | "success_rate"; severity: string; message: string; value: number }[] = [];
  const recent = runs.slice(0, 20);
  if (recent.length >= 5) {
    const pass = recent.filter((r) => r.status === "passed").length / recent.length;
    if (pass < 0.6) {
      alerts.push({
        kind: "success_rate",
        severity: pass < 0.3 ? "critical" : "warning",
        message: `Success rate ${Math.round(pass * 100)}% over last ${recent.length} runs`,
        value: pass,
      });
    }
  }
  const costs = runs.map((r) => r.costUsd ?? 0).filter((c) => c > 0);
  if (costs.length >= 3) {
    const median = [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)];
    const last = costs[0] ?? runs[0]?.costUsd ?? 0;
    if (median > 0 && last > median * 3) {
      alerts.push({
        kind: "cost_spike",
        severity: "warning",
        message: `Latest LLM cost $${last.toFixed(4)} is >3x median $${median.toFixed(4)}`,
        value: last,
      });
    }
  }
  return alerts;
}

export { hashToken };
