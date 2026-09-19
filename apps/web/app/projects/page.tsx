"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type Project = { id: string; name: string };
type Key = { id: string; name: string; prefix: string; createdAt: string };

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ projects: Project[] }>("/v1/projects")
      .then((r) => {
        setProjects(r.projects);
        if (r.projects[0]) setSelected(r.projects[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    api<{ keys: Key[] }>(`/v1/projects/${selected}/keys`)
      .then((r) => setKeys(r.keys))
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  async function mint() {
    const res = await api<{ key: string }>(`/v1/projects/${selected}/keys`, {
      method: "POST",
      body: JSON.stringify({ name: "dashboard" }),
    });
    setFreshKey(res.key);
    const list = await api<{ keys: Key[] }>(`/v1/projects/${selected}/keys`);
    setKeys(list.keys);
  }

  if (error) {
    return (
      <AppPage kicker="Projects" title="Keys for MCP and sync.">
        <p className="error">{error}</p>
      </AppPage>
    );
  }

  return (
    <AppPage
      kicker="Projects"
      title="Keys for MCP and sync."
      hint={{
        steps: [
          "API keys authenticate the CLI, `veriflow login`, and MCP sync calls.",
          "Mint a key, copy it once (it isn't shown again), and run `veriflow login --token …` on your machine.",
        ],
        cli: "npx veriflow login --token <your-key>",
      }}
    >
      <label>
        Project
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <ul>
        {keys.map((k) => (
          <li key={k.id}>
            {k.name} <code>{k.prefix}…</code>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => mint()}>
        Create project API key
      </button>
      {freshKey ? (
        <p>
          Copy now: <code>{freshKey}</code>
        </p>
      ) : null}
    </AppPage>
  );
}
