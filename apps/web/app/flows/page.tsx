"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type Flow = { id: string; name: string; objective: string; envUrl?: string };
type Run = { id: string; flowId?: string; status: string; startedAt: string };

export default function FlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [envUrl, setEnvUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);

  function load() {
    api<{ flows: Flow[] }>("/v1/flows")
      .then((r) => setFlows(r.flows))
      .catch((e: Error) => setError(e.message));
    api<{ runs: Run[] }>("/v1/runs?limit=200")
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }

  useEffect(() => {
    load();
  }, []);

  async function saveFlow() {
    if (!objective.trim()) {
      setNote("objective required");
      return;
    }
    try {
      await api("/v1/flows", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() || objective.slice(0, 60), objective, envUrl: envUrl.trim() || undefined }),
      });
      setNote("flow saved");
      setName("");
      setObjective("");
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function rerun(flow: Flow) {
    try {
      const res = await api<{ id: string }>("/v1/runs", {
        method: "POST",
        body: JSON.stringify({
          flowId: flow.id,
          objective: flow.objective,
          envUrl: flow.envUrl,
          status: "queued",
          stepCount: 0,
        }),
      });
      router.push(`/runs/${res.id}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) {
    return (
      <AppPage kicker="Flows" title="Saved objectives, ready to re-run.">
        <p className="error">{error}. <Link href="/login">Sign in</Link> first.</p>
      </AppPage>
    );
  }
  if (!flows) {
    return (
      <AppPage kicker="Flows" title="Saved objectives, ready to re-run.">
        <p className="empty">Loading flows…</p>
      </AppPage>
    );
  }

  return (
    <AppPage kicker="Flows" title="Saved objectives, ready to re-run.">
      <p className="empty">
        Flows come from `veriflow run` (saved automatically), `veriflow import`, or the form below. Re-run queues a cloud
        record; the CLI still owns the browser.
      </p>
      {flows.length === 0 ? (
        <p>No flows yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Objective</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {flows.map((f) => {
              const last = runs.find((r) => r.flowId === f.id);
              return (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td>{f.objective}</td>
                  <td>
                    {last ? (
                      <Link href={`/runs/${last.id}`}>
                        {last.status} · {last.startedAt.slice(0, 10)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <button type="button" onClick={() => rerun(f)}>
                      Queue re-run
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Save a flow</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout smoke" />
      </label>
      <label>
        Objective
        <input
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Log in, add a plan to the cart, assert the total"
        />
      </label>
      <label>
        Start URL
        <input value={envUrl} onChange={(e) => setEnvUrl(e.target.value)} placeholder="https://staging.example.com" />
      </label>
      <button type="button" onClick={saveFlow}>
        Save flow
      </button>
      {note ? <p className="empty">{note}</p> : null}
    </AppPage>
  );
}
