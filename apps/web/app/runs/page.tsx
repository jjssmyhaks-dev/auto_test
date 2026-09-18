"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { AppPage } from "@/components/app-page";

type Run = { id: string; objective: string; status: string; startedAt: string; costUsd?: number };

export default function RunsPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [envUrl, setEnvUrl] = useState("https://example.com");
  const [draft, setDraft] = useState("");

  function load() {
    api<{ runs: Run[] }>("/v1/runs")
      .then((r) => setRuns(r.runs))
      .catch((e: Error) => setError(e.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function queueRun(message: PromptInputMessage) {
    const objective = message.text.trim();
    if (!objective) return;
    setNote(null);
    try {
      const res = await api<{ id: string }>("/v1/runs", {
        method: "POST",
        body: JSON.stringify({ objective, envUrl, status: "queued", stepCount: 0 }),
      });
      setDraft("");
      setNote(`Queued ${res.id}. Execute locally with veriflow run, then --sync.`);
      load();
      router.push(`/runs/${res.id}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) {
    return (
      <AppPage kicker="Runs" title="Queue an objective.">
        <p className="error">{error}. <Link href="/login">Sign in</Link> first.</p>
      </AppPage>
    );
  }
  if (!runs) {
    return (
      <AppPage kicker="Runs" title="Queue an objective.">
        <p className="empty">Loading runs…</p>
      </AppPage>
    );
  }
  return (
    <AppPage kicker="Runs" title="Queue an objective.">
      <p className="empty">
        Queue an objective here (cloud record). The browser harness still runs on the CLI — this does not start Chromium from the dashboard.
      </p>
      <label>
        Start URL
        <input value={envUrl} onChange={(e) => setEnvUrl(e.target.value)} />
      </label>
      <PromptInput className="mt-3" onSubmit={queueRun}>
        <PromptInputTextarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder="open https://example.com and assert the heading contains Example"
        />
        <PromptInputFooter>
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
      {note ? <p className="empty">{note}</p> : null}
      {runs.length === 0 ? (
        <p className="empty">No cloud runs yet. Queue one above or use `veriflow run … --sync` after login.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Objective</th>
              <th>When</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.status}</td>
                <td>
                  <Link href={`/runs/${r.id}`}>{r.objective || r.id}</Link>
                </td>
                <td>{r.startedAt}</td>
                <td>{r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppPage>
  );
}
