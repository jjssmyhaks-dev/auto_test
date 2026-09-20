"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";
import { ONBOARDING_ACTIONS, resetOnboarding, useOnboarding } from "@/lib/onboarding";

type Member = { userId: string; email?: string; role: string; createdAt: string };
type Invite = { id: string; email: string; role: string; status: string };



/**
 * Account settings. The reset control clears onboarding progress in BOTH
 * places it lives: the account row (DELETE /v1/progress) and the local
 * cache, so the checklist and completion state genuinely start over.
 */
export default function SettingsPage() {
  const { done, dismissed } = useOnboarding();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [demoNote, setDemoNote] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const router = useRouter();

  // Team membership: who's on the project, pending invites, invite form.
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [teamNote, setTeamNote] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  // Cost cap: monthly USD ceiling; the API 402s runs that exceed it.
  const [costCap, setCostCap] = useState<string>("");
  useEffect(() => {
    api<{ user: { costCapUsd?: number } }>("/v1/me")
      .then((r) => setCostCap(r.user.costCapUsd !== undefined ? String(r.user.costCapUsd) : ""))
      .catch(() => {});
  }, []);
  async function saveCostCap() {
    const parsed = costCap.trim() === "" ? null : Number(costCap);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setNote("cost cap must be a non-negative number");
      return;
    }
    try {
      await api("/v1/settings/cost-cap", { method: "POST", body: JSON.stringify({ costCapUsd: parsed }) });
      setNote(parsed === null ? "cost cap cleared" : `cost cap set to $${parsed}/month`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  const loadTeam = useCallback(() => {
    api<{ projects: { id: string }[] }>("/v1/projects")
      .then((r) => {
        const pid = r.projects[0]?.id;
        if (!pid) throw new Error("no project");
        return Promise.all([
          pid,
          api<{ members: Member[] }>(`/v1/projects/${pid}/members`),
          api<{ invites: Invite[] }>(`/v1/projects/${pid}/invites`).catch(() => ({ invites: [] as Invite[] })),
        ]);
      })
      .then(([pid, m, i]) => {
        setMembers(m.members);
        setInvites(i.invites);
        (window as unknown as { __vfPid?: string }).__vfPid = pid;
      })
      .catch(() => setMembers([]));
  }, []);

  useEffect(() => {
    loadTeam();
  }, [loadTeam]);

  async function sendInvite() {
    const pid = (window as unknown as { __vfPid?: string }).__vfPid;
    if (!pid || !inviteEmail.trim()) return;
    try {
      const res = await api<{ acceptToken?: string }>(`/v1/projects/${pid}/invites`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const link = res.acceptToken ? ` — accept at /login?invite=${res.acceptToken}` : "";
      setTeamNote(`Invited ${inviteEmail.trim()} as ${inviteRole}${link}`);
      setInviteEmail("");
      loadTeam();
    } catch (e) {
      setTeamNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function changeRole(userId: string, role: string) {
    const pid = (window as unknown as { __vfPid?: string }).__vfPid;
    if (!pid) return;
    try {
      await api(`/v1/projects/${pid}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) });
      loadTeam();
    } catch (e) {
      setTeamNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeMember(userId: string) {
    const pid = (window as unknown as { __vfPid?: string }).__vfPid;
    if (!pid) return;
    try {
      await api(`/v1/projects/${pid}/members/${userId}`, { method: "DELETE" });
      loadTeam();
    } catch (e) {
      setTeamNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function revokeInvite(inviteId: string) {
    const pid = (window as unknown as { __vfPid?: string }).__vfPid;
    if (!pid) return;
    try {
      await api(`/v1/projects/${pid}/invites/${inviteId}`, { method: "DELETE" });
      loadTeam();
    } catch (e) {
      setTeamNote(e instanceof Error ? e.message : String(e));
    }
  }

  const completed = ONBOARDING_ACTIONS.filter((a) => done[a.key]).length;

  async function reset() {
    setBusy(true);
    setNote(null);
    // Clear the account's progress first; wipe the cache even if the API
    // is unreachable (it will re-sync whatever the account still has).
    try {
      await api("/v1/progress", { method: "DELETE" });
      resetOnboarding({ skipRemote: true });
      setNote("Progress cleared — the checklist and tour start over.");
    } catch {
      resetOnboarding();
      setNote("Couldn't reach the API; cleared local progress only.");
    }
    // Also drop the tour's local resume/done flags so it replays from 01.
    localStorage.removeItem("veriflow_tour_done");
    localStorage.removeItem("veriflow_tour_step");
    localStorage.removeItem("veriflow_tour_mode");
    setBusy(false);
    router.refresh();
  }

  // Demo reset: wipe the project's runs, flows, and alert rules (plus their
  // evidence blobs and usage ledger) server-side, then reload so the whole
  // dashboard replays from scratch. Team-gated like the API.
  async function demoReset() {
    if (!window.confirm("Delete all runs, flows, and alert rules for this project? This cannot be undone.")) return;
    setDemoBusy(true);
    setDemoNote(null);
    try {
      const res = await api<{ status: string; runs: number; flows: number; alertRules: number; blobsRemoved: number }>(
        "/v1/demo-reset",
        { method: "POST" },
      );
      setDemoNote(`Cleared ${res.runs} run(s), ${res.flows} flow(s), ${res.alertRules} rule(s), ${res.blobsRemoved} evidence file(s).`);
      router.refresh();
    } catch (e) {
      setDemoNote(e instanceof Error ? e.message : "Demo reset failed.");
    }
    setDemoBusy(false);
  }

  return (
    <AppPage
      kicker="Settings"
      title="Progress, under control."
      hint={{
        steps: [
          "Resetting onboarding clears the checklist, the 4/4 completion state, and the tour's resume point.",
          "Reset affects the account: every signed-in device picks it up on its next sync.",
        ],
      }}
    >
      <section aria-label="Onboarding progress">
        <h2>Onboarding</h2>
        <p>
          {completed} / {ONBOARDING_ACTIONS.length} key actions completed
          {dismissed ? " · checklist dismissed" : ""}.
        </p>
        <p className="text-sm text-foreground/70">
          Resetting re-arms the getting-started checklist and the guided tour — useful for demos or a
          fresh teammate sharing this account. Progress re-accumulates as the actions are performed.
        </p>
        <div className="mt-3 row">
          <button type="button" onClick={reset} disabled={busy}>
            {busy ? "Clearing…" : "Reset onboarding"}
          </button>
        </div>
        {note ? <p className="mt-2">{note}</p> : null}
      </section>
      <section aria-label="Cost cap" className="mt-8">
        <h2>Cost cap</h2>
        <p className="text-sm text-foreground/70">
          Monthly USD ceiling for LLM spend on this account. When a run would push spend past the
          cap, the API refuses it with <code>cost_cap_exceeded</code> instead of charging on. Leave
          empty for no cap.
        </p>
        <div className="mt-3 row">
          <input
            value={costCap}
            onChange={(e) => setCostCap(e.target.value)}
            placeholder="e.g. 25.00"
            className="max-w-40"
          />
          <button type="button" onClick={saveCostCap}>
            Save cost cap
          </button>
        </div>
      </section>
      <section aria-label="Demo data" className="mt-8">
        <h2>Demo data</h2>
        <p className="text-sm text-foreground/70">
          Wipes every run (with steps, spans, and evidence files), flow, alert rule, and usage
          ledger entry for this project, so the dashboard replays from an empty slate. Onboarding
          progress and the tour are kept — reset those separately above. Team tier only.
        </p>
        <div className="mt-3 row">
          <button type="button" className="secondary" onClick={demoReset} disabled={demoBusy}>
            {demoBusy ? "Wiping…" : "Reset demo data"}
          </button>
        </div>
        {demoNote ? <p className="mt-2">{demoNote}</p> : null}
      </section>
      <section aria-label="Team" className="mt-8">
        <h2>Team</h2>
        {members === null ? (
          <p className="empty">Loading members…</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>{m.email ?? m.userId}</td>
                    <td>{m.role}</td>
                    <td>
                      {m.role !== "owner" ? (
                        <>
                          <select value={m.role} onChange={(e) => changeRole(m.userId, e.target.value)}>
                            <option value="admin">admin</option>
                            <option value="member">member</option>
                            <option value="viewer">viewer</option>
                          </select>{" "}
                          <button type="button" onClick={() => removeMember(m.userId)}>
                            remove
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {invites.filter((i) => i.status === "pending").length > 0 ? (
              <p className="empty">
                Pending: {invites.filter((i) => i.status === "pending").map((i) => `${i.email} (${i.role})`).join(", ")}
              </p>
            ) : null}
            <div className="mt-3 row">
              <input
                value={inviteEmail}
                placeholder="teammate@acme.dev"
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                <option value="admin">admin</option>
                <option value="member">member</option>
                <option value="viewer">viewer</option>
              </select>
              <button type="button" onClick={sendInvite}>
                Invite
              </button>
            </div>
            {teamNote ? <p className="mt-2 empty">{teamNote}</p> : null}
          </>
        )}
      </section>
    </AppPage>
  );
}
