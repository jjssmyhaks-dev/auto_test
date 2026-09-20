"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { RunTraceView } from "@/components/run-trace-view";
import Link from "next/link";
import { TraceScrubber } from "@/components/trace-scrubber";
import { LiveRunPane } from "@/components/live-run-pane";
import { SelfHealReview } from "@/components/self-heal-review";
import { AppPage } from "@/components/app-page";

type Trace = {
  run: { id: string; objective: string; status: string; error?: string; flowId?: string };
  steps: { index: number; action: unknown; status: string }[];
  spans: { kind: string; ok?: boolean; startedAt: string; error?: string; attributes?: Record<string, unknown> }[];
  screenshots: string[];
  videoUrl?: string;
  heals?: { stepIndex: number; failure: string; repairedSelector?: string; originalSelector?: string }[];
  capture?: { network?: { url: string; method: string; status?: number }[]; console?: { type: string; text: string }[] };
};

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <AppPage
      kicker="Run"
      title={trace.run.objective || trace.run.id}
      hint={{
        steps: [
          "The timeline strip is the scrubber: click any mark (or use ←/→) to jump between steps.",
          "The filmstrip shows every step's screenshot — click a frame to inspect that moment.",
          "Each step lists its spans; failed steps show the guardrail or assertion that rejected them.",
        ],
      }}
    >
      <p>
        Status <strong>{trace.run.status}</strong>
        {trace.run.error ? ` — ${trace.run.error}` : ""}
      </p>
      <LiveRunPane runId={trace.run.id} status={trace.run.status} />
      {trace.heals && trace.heals.length > 0 ? (
        <div className="mt-2">
          <SelfHealReview runId={trace.run.id} flowId={trace.run.flowId} heals={trace.heals} />
        </div>
      ) : null}
      <RunTraceView objective={trace.run.objective} steps={trace.steps} spans={trace.spans} />
      <h2>Scrubber</h2>
      <TraceScrubber steps={trace.steps} spans={trace.spans} screenshots={trace.screenshots} />
      {trace.videoUrl ? (
        <>
          <h2>Video</h2>
          <video controls src={trace.videoUrl} className="max-w-2xl border border-foreground/25" />
          <p className="empty">
            <a href={trace.videoUrl} download className="underline">
              Download video.webm
            </a>
          </p>
        </>
      ) : null}
      <p className="mt-2 text-sm">
        <Link href={`/runs/compare?a=${trace.run.id}&b=`} className="underline">
          Compare this run against another →
        </Link>
      </p>
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
