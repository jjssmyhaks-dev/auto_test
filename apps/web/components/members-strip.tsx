"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type ProjectRole = "owner" | "admin" | "member" | "viewer";

export type Member = {
  userId: string;
  email?: string;
  role: ProjectRole;
  createdAt?: string;
};

/** Per-role accent so permissions read at a glance. */
const ROLE_STYLE: Record<ProjectRole, string> = {
  owner: "border-foreground text-foreground",
  admin: "border-foreground/60 text-foreground",
  member: "border-foreground/35 text-foreground/80",
  viewer: "border-foreground/25 text-foreground/60",
};

export function RoleBadge({ role }: { role: ProjectRole }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide ${ROLE_STYLE[role]}`}
      title={`Project role: ${role}`}
    >
      {role}
    </span>
  );
}

/**
 * Compact members list for a single project — role badges included — so
 * per-project permissions are visible anywhere in the dashboard, not just
 * in Settings. Read-only by design; management lives in Settings → Team.
 */
export function MembersStrip({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMembers(null);
    setError(null);
    api<{ members: Member[] }>(`/v1/projects/${projectId}/members`)
      .then((r) => setMembers(r.members))
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  if (error) return <p className="empty">Members unavailable: {error}</p>;
  if (!members) return <p className="empty">Loading members…</p>;
  if (members.length === 0) return <p className="empty">No members.</p>;

  return (
    <ul aria-label="Project members">
      {members.map((m) => (
        <li key={m.userId} className="flex items-center gap-2">
          <span>{m.email ?? m.userId.slice(0, 8)}</span>
          <RoleBadge role={m.role} />
        </li>
      ))}
    </ul>
  );
}
