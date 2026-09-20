"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";
import { RoleBadge, type ProjectRole } from "@/components/members-strip";

type Workspace = { id: string; name: string; userId: string; createdAt: string };
type Member = { workspaceId: string; userId: string; email?: string; role: ProjectRole };
type Project = { id: string; name: string; workspaceId?: string };
type Rollup = {
  projects: { projectId: string; name: string; runs: number; usd: number }[];
  totals: { runs: number; usd: number };
};

export default function WorkspacePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [name, setName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function loadAll(ws?: string) {
    api<{ workspaces: Workspace[] }>("/v1/workspaces")
      .then((r) => {
        setWorkspaces(r.workspaces);
        const id = ws ?? selected ?? r.workspaces[0]?.id ?? "";
        setSelected(id);
        if (!id) return;
        api<{ members: Member[] }>(`/v1/workspaces/${id}/members`)
          .then((x) => setMembers(x.members))
          .catch(() => setMembers([]));
        api<Rollup>(`/v1/workspaces/${id}/usage`)
          .then(setRollup)
          .catch(() => setRollup(null));
      })
      .catch((e: Error) => setError(e.message));
    api<{ projects: Project[] }>("/v1/projects")
      .then((r) => setProjects(r.projects))
      .catch(() => {});
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!name.trim()) return setNote("give the workspace a name");
    const r = await api<{ workspace: Workspace }>("/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    setNote(`workspace "${r.workspace.name}" created`);
    setName("");
    loadAll(r.workspace.id);
  }

  async function addMember() {
    if (!selected || !inviteEmail) return;
    try {
      await api(`/v1/workspaces/${selected}/members`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      setNote(`${inviteEmail} added as ${inviteRole}`);
      setInviteEmail("");
      loadAll();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function setRole(userId: string, role: ProjectRole) {
    if (!selected) return;
    try {
      await api(`/v1/workspaces/${selected}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      loadAll();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function attach(projectId: string) {
    if (!selected) return setNote("select or create a workspace first");
    try {
      await api(`/v1/workspaces/${selected}/projects`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      });
      setNote("project attached — workspace roles now apply to it");
      loadAll();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  const attachable = projects.filter((p) => !p.workspaceId);

  return (
    <AppPage
      kicker="Workspace"
      title="One roof for many projects."
      hint={{
        steps: [
          "A workspace groups projects; its roles apply across ALL of them — viewer here reads every project inside.",
          "Per-project roles can still grant MORE than the workspace floor, never less.",
          "The usage rollup sums runs and dollars across every attached project.",
        ],
      }}
    >
      {error ? <p className="error">{error}</p> : null}
      <label>
        Workspace
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            loadAll(e.target.value);
          }}
        >
          {(workspaces ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <input value={name} placeholder="New workspace name" onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={create}>
          Create workspace
        </button>
      </div>

      {selected ? (
        <>
          <h2>Members</h2>
          <p className="text-sm text-foreground/70">
            Workspace roles are floors: an admin here administers every project inside, whatever its
            per-project settings say.
          </p>
          <ul>
            {members.map((m) => (
              <li key={m.userId} className="flex items-center gap-2">
                <span>{m.email ?? m.userId.slice(0, 8)}</span>
                <RoleBadge role={m.role} />
                {m.role !== "owner" ? (
                  <select value={m.role} onChange={(e) => setRole(m.userId, e.target.value as ProjectRole)}>
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                    <option value="viewer">viewer</option>
                  </select>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="row">
            <input
              value={inviteEmail}
              placeholder="teammate@acme.dev"
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
              <option value="admin">admin</option>
              <option value="member">member</option>
              <option value="viewer">viewer</option>
            </select>
            <button type="button" onClick={addMember}>
              Add member
            </button>
          </div>

          <h2>Attach a project</h2>
          {attachable.length === 0 ? (
            <p className="empty">All projects are already in workspaces.</p>
          ) : (
            <ul>
              {attachable.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <span>{p.name}</span>
                  <button type="button" onClick={() => attach(p.id)}>
                    Attach
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h2>Usage rollup</h2>
          {!rollup ? (
            <p className="empty">No usage yet in this workspace.</p>
          ) : rollup.projects.length === 0 ? (
            <p className="empty">No usage recorded for attached projects yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Runs</th>
                  <th>Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {rollup.projects.map((p) => (
                  <tr key={p.projectId}>
                    <td>{p.name}</td>
                    <td>{p.runs}</td>
                    <td>${p.usd.toFixed(4)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td>
                    <strong>{rollup.totals.runs}</strong>
                  </td>
                  <td>
                    <strong>${rollup.totals.usd.toFixed(4)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p className="empty">Create a workspace to group projects and share them with roles.</p>
      )}
      {note ? <p className="empty">{note}</p> : null}
    </AppPage>
  );
}
