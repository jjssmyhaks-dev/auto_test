"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { RunTraceView } from "@/components/run-trace-view";
import { AppPage } from "@/components/app-page";

type Run = { id: string; objective: string; status: string };
type Trace = {
  run: { id: string; objective: string; status: string; error?: string };
  steps: { index: number; action: unknown; status: string }[];
  spans: { kind: string; ok?: boolean; startedAt: string; error?: string; attributes?: Record<string, unknown> }[];
  screenshots: string[];
};

export default function EvidencePage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [selected, setSelected] = useState("");
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ runs: Run[] }>("/v1/runs")
      .then((r) => {
        setRuns(r.runs);
        if (r.runs[0]) setSelected(r.runs[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setTrace(null);
    api<Trace>(`/v1/runs/${selected}/trace`)
      .then(setTrace)
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  if (error) {
    return (
      <AppPage kicker="Evidence" title="Replay a packed run.">
        <p className="error">{error}. <Link href="/login">Sign in</Link> first.</p>
      </AppPage>
    );
  }
  if (!runs) {
    return (
      <AppPage kicker="Evidence" title="Replay a packed run.">
        <p className="empty">Loading evidence…</p>
      </AppPage>
    );
  }

  return (
    <AppPage
      kicker="Evidence"
      title="Replay a packed run."
      hint={{
        steps: [
          "Each cloud run carries a tamper-hashed evidence pack — inputs, model outputs, and proof it wasn't altered.",
          "Pick a run to replay its conversation inline; the CLI ships the same pack via `veriflow export`.",
        ],
        cli: "npx veriflow export --run <id>",
      }}
    >
      {runs.length === 0 ? (
        <p className="empty">
          No synced runs. Queue an objective on <Link href="/runs">Runs</Link> or `veriflow run … --sync`.
        </p>
      ) : (
        <>
          <label>
            Run
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.status} — {r.objective || r.id}
                </option>
              ))}
            </select>
          </label>
          {trace ? (
            <>
              <p>
                <Link href={`/runs/${trace.run.id}`}>Open run detail</Link> · status{" "}
                <strong>{trace.run.status}</strong>
                {trace.run.error ? ` — ${trace.run.error}` : ""}
              </p>
              <RunTraceView objective={trace.run.objective} steps={trace.steps} spans={trace.spans} />
              {trace.screenshots[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="shot" src={trace.screenshots[0]} alt="first screenshot" />
              ) : (
                <p className="empty">No screenshots on this run.</p>
              )}
            </>
          ) : (
            <p className="empty">Loading trace…</p>
          )}
        </>
      )}
    </AppPage>
  );
}
