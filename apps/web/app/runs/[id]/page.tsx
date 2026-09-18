"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { RunTraceView } from "@/components/run-trace-view";
import { AppPage } from "@/components/app-page";

type Trace = {
  run: { id: string; objective: string; status: string; error?: string };
  steps: { index: number; action: unknown; status: string }[];
  spans: { kind: string; ok?: boolean; startedAt: string; error?: string; attributes?: Record<string, unknown> }[];
  screenshots: string[];
  capture?: { network?: { url: string; method: string; status?: number }[]; console?: { type: string; text: string }[] };
};

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState(0);

  useEffect(() => {
    if (!params.id) return;
    api<Trace>(`/v1/runs/${params.id}/trace`)
      .then(setTrace)
      .catch((e: Error) => setError(e.message));
  }, [params.id]);

  if (error) {
    return (
      <AppPage kicker="Run" title="Could not load this trace.">
        <p className="error">{error}</p>
      </AppPage>
    );
  }
  if (!trace) {
    return (
      <AppPage kicker="Run" title="Loading evidence…">
        <p className="empty">Fetching trace, spans, and screenshots.</p>
      </AppPage>
    );
  }

  return (
    <AppPage kicker="Run" title={trace.run.objective || trace.run.id}>
      <p>
        Status <strong>{trace.run.status}</strong>
        {trace.run.error ? ` — ${trace.run.error}` : ""}
      </p>
      <RunTraceView objective={trace.run.objective} steps={trace.steps} spans={trace.spans} />
      {trace.screenshots.length > 0 ? (
        <>
          <h2>Screenshots</h2>
          <div className="row">
            <button type="button" onClick={() => setShot((s) => Math.max(0, s - 1))}>
              Prev
            </button>
            <span>
              {shot + 1} / {trace.screenshots.length}
            </span>
            <button
              type="button"
              onClick={() => setShot((s) => Math.min(trace.screenshots.length - 1, s + 1))}
            >
              Next
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="shot" src={trace.screenshots[shot]} alt={`step ${shot}`} />
        </>
      ) : (
        <p className="empty">No screenshots uploaded with this run.</p>
      )}
      {trace.capture?.network?.length ? (
        <>
          <h2>Network</h2>
          <ol>
            {trace.capture.network.slice(0, 40).map((n, i) => (
              <li key={i}>
                {n.method} {n.status ?? "—"} {n.url}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {trace.capture?.console?.length ? (
        <>
          <h2>Console</h2>
          <ol>
            {trace.capture.console.slice(0, 40).map((n, i) => (
              <li key={i}>
                {n.type}: {n.text}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </AppPage>
  );
}
