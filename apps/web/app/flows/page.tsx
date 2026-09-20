"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";
import { markAction } from "@/lib/onboarding";

type Flow = { id: string; name: string; objective: string; envUrl?: string; schedule?: string; version?: number; quarantined?: boolean; retryPolicy?: { maxAttempts: number; backoffSeconds: number } };
type Run = { id: string; flowId?: string; status: string; startedAt: string };
type Flake = { flakeScore: number; runsConsidered: number; flips: number };
type FlowVersion = { version: number; name: string; objective: string; schedule?: string; changeHash: string; lastGreenRunId?: string; createdAt: string; note?: string };
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
  const [flake, setFlake] = useState<Record<string, Flake>>({});
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<FlowVersion[]>([]);
  const [maxAttempts, setMaxAttempts] = useState("1");
  const [backoff, setBackoff] = useState("30");

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
    api<{ flows: Flow[] }>("/v1/flows")
      .then(async (r) => {
        const next: Record<string, Flake> = {};
        for (const f of r.flows) {
          try {
            next[f.id] = await api<Flake>(`/v1/flows/${f.id}/flake`);
          } catch {
            /* flake view is best-effort */
          }
        }
        setFlake(next);
      })
      .catch(() => {});
  }

  async function showVersions(flow: Flow) {
    if (versionsFor === flow.id) {
      setVersionsFor(null);
      return;
    }
    try {
      const r = await api<{ versions: FlowVersion[] }>(`/v1/flows/${flow.id}/versions`);
      setVersions(r.versions);
      setVersionsFor(flow.id);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function rollback(flow: Flow, version: number) {
    try {
      await api(`/v1/flows/${flow.id}/rollback`, { method: "POST", body: JSON.stringify({ version }) });
      setNote(`rolled back to v${version} (saved as a new version)`);
      setVersionsFor(null);
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleQuarantine(flow: Flow) {
    try {
      await api("/v1/flows", {
        method: "POST",
        body: JSON.stringify({ id: flow.id, name: flow.name, objective: flow.objective, envUrl: flow.envUrl, schedule: flow.schedule ?? null, quarantined: !flow.quarantined, projectId: undefined }),
      });
      setNote(flow.quarantined ? "flow removed from quarantine" : "flow quarantined — suites and schedules will skip it");
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
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
          retryPolicy: Number(maxAttempts) > 1 ? { maxAttempts: Math.max(1, Math.min(5, Number(maxAttempts) || 1)), backoffSeconds: Math.max(0, Number(backoff) || 30) } : undefined,
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
                  <td className="whitespace-nowrap">
                    <span className="font-mono text-[10px]">v{f.version ?? 1}</span>{" "}
                    {f.quarantined ? <span className="rounded bg-yellow-200 px-1 text-[10px] uppercase">quarantine</span> : null}
                    {flake[f.id] && flake[f.id].runsConsidered >= 3 ? (
                      <span
                        className={`ml-1 rounded px-1 text-[10px] ${
                          flake[f.id].flakeScore >= 0.25
                            ? "bg-red-200"
                            : flake[f.id].flakeScore >= 0.1
                              ? "bg-yellow-200"
                              : "bg-green-200"
                        }`}
                      >
                        flaky {Math.round(flake[f.id].flakeScore * 100)}%
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <button type="button" onClick={() => rerun(f)}>
                      Queue re-run
                    </button>{" "}
                    <button type="button" onClick={() => showVersions(f)}>
                      Versions
                    </button>{" "}
                    <button type="button" onClick={() => toggleQuarantine(f)}>
                      {f.quarantined ? "Un-quarantine" : "Quarantine"}
                    </button>{" "}
                    {f.schedule ? (
                      <button type="button" onClick={() => downloadWorkflow(f)}>
                        CI workflow
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            }            )}
          </tbody>
        </table>
      )}

      {versionsFor ? (
        <>
          <h2>Version history</h2>
          <p className="empty">
            Every distinct definition is snapshotted. Rollback copies an old version forward as a new version — history is
            never rewritten. Green marks the last passing run on that version.
          </p>
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Objective</th>
                <th>Change</th>
                <th>Last green</th>
                <th>Note</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}</td>
                  <td>{v.objective.slice(0, 70)}</td>
                  <td className="font-mono text-[10px]">{v.changeHash}</td>
                  <td>
                    {v.lastGreenRunId ? <Link href={`/runs/${v.lastGreenRunId}`}>{v.lastGreenRunId.slice(0, 14)}…</Link> : "—"}
                  </td>
                  <td>{v.note ?? ""}</td>
                  <td>
                    <button type="button" onClick={() => rollback(flows.find((f) => f.id === versionsFor)!, v.version)}>
                      Roll back
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

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
      <label>
        Retry attempts on failure (1–5)
        <input value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} placeholder="1" />
      </label>
      <label>
        Seconds between retries
        <input value={backoff} onChange={(e) => setBackoff(e.target.value)} placeholder="30" />
      </label>
      <button type="button" onClick={saveFlow}>
        Save flow
      </button>
      {note ? <p className="empty">{note}</p> : null}
    </AppPage>
  );
}
