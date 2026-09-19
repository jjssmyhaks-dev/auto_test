"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";
import { markAction } from "@/lib/onboarding";

type Flow = { id: string; name: string; objective: string; envUrl?: string; schedule?: string };
type Run = { id: string; flowId?: string; status: string; startedAt: string };
type Rollup = {
  flowId: string;
  windowDays: number;
  runs: number;
  successRate: number;
  medianSteps: number;
  avgCostUsd: number;
  selfHealRate: number;
  humanInterventionRate: number;
  guardAbortRate: number;
};

export default function FlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [rollups, setRollups] = useState<Rollup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [envUrl, setEnvUrl] = useState("");
  const [schedule, setSchedule] = useState("");
  const [note, setNote] = useState<string | null>(null);

  function load() {
    api<{ flows: Flow[] }>("/v1/flows")
      .then((r) => setFlows(r.flows))
      .catch((e: Error) => setError(e.message));
    api<{ runs: Run[] }>("/v1/runs?limit=200")
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
    api<{ rollups: Rollup[] }>("/v1/metrics/rollups")
      .then((r) => setRollups(r.rollups))
      .catch(() => setRollups([]));
  }

  async function refreshMetrics() {
    try {
      await api("/v1/metrics/rollups/refresh", { method: "POST" });
      const r = await api<{ rollups: Rollup[] }>("/v1/metrics/rollups");
      setRollups(r.rollups);
      setNote("metrics refreshed");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
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
        body: JSON.stringify({
          name: name.trim() || objective.slice(0, 60),
          objective,
          envUrl: envUrl.trim() || undefined,
          schedule: schedule.trim() || null,
        }),
      });
      setNote(schedule.trim() ? `flow saved (runs on schedule "${schedule.trim()}")` : "flow saved");
      markAction("create_flow");
      setName("");
      setObjective("");
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  /** Download a ready-to-commit GitHub Actions cron workflow for this flow. */
  async function downloadWorkflow(flow: Flow) {
    try {
      const res = await api<{ filename: string; workflow: string }>(`/v1/flows/${flow.id}/cron-workflow`);
      const blob = new Blob([res.workflow], { type: "text/x-yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      setNote(`downloaded ${res.filename} — commit to .github/workflows/ and set VERIFLOW_API_KEY as a repo secret`);
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
    <AppPage
      kicker="Flows"
      title="Saved objectives, ready to re-run."
      hint={{
        steps: [
          "Every cloud run is saved as a flow automatically — no extra setup.",
          "Queue re-run replays the objective against today's app: your regression suite.",
          "The Reliability table is 7/30-day rollups (success, self-heal, cost) — refreshed on demand, never raw spans.",
        ],
        cli: "npx veriflow flows",
      }}
    >
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
              <th>Schedule</th>
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
                  <td className="font-mono text-[10px]">{f.schedule ?? "manual"}</td>
                  <td>
                    <button type="button" onClick={() => rerun(f)}>
                      Queue re-run
                    </button>{" "}
                    {f.schedule ? (
                      <button type="button" onClick={() => downloadWorkflow(f)}>
                        CI workflow
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2>Reliability (30-day rollups)</h2>
      <p className="empty">
        Precomputed per flow so the dashboard never scans raw spans. {rollups.length === 0 ? "Nothing yet — refresh to compute." : ""}
      </p>
      {rollups.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Flow</th>
              <th>Success</th>
              <th>Self-heal</th>
              <th>Human</th>
              <th>Guard aborts</th>
              <th>Steps p50</th>
              <th>Avg cost</th>
              <th>Runs</th>
            </tr>
          </thead>
          <tbody>
            {rollups
              .filter((r) => r.windowDays === 30)
              .map((r) => (
                <tr key={r.flowId}>
                  <td>{r.flowId === "_project" ? "(no flow)" : r.flowId}</td>
                  <td>{Math.round(r.successRate * 100)}%</td>
                  <td>{Math.round(r.selfHealRate * 100)}%</td>
                  <td>{Math.round(r.humanInterventionRate * 100)}%</td>
                  <td>{Math.round(r.guardAbortRate * 100)}%</td>
                  <td>{r.medianSteps}</td>
                  <td>${r.avgCostUsd.toFixed(4)}</td>
                  <td>{r.runs}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : null}
      <button type="button" onClick={refreshMetrics}>
        Refresh metrics
      </button>

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
      <label>
        Schedule (cron, optional)
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="*/30 * * * *  — every 30 minutes; 0 9 * * 1-5 — weekdays 9am"
        />
      </label>
      <button type="button" onClick={saveFlow}>
        Save flow
      </button>
      {note ? <p className="empty">{note}</p> : null}
    </AppPage>
  );
}
