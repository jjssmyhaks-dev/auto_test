"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type Device = { id: string; name: string; status: string; lastHeartbeatAt: string };
type Job = { id: string; objective: string; envUrl?: string; status: string; claimedBy?: string; resultRunId?: string; createdAt: string };

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [objective, setObjective] = useState("");
  const [envUrl, setEnvUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api<{ devices: Device[] }>("/v1/devices")
      .then((d) => setDevices(d.devices))
      .catch((e: Error) => setError(e.message));
    api<{ jobs: Job[] }>("/v1/device-jobs")
      .then((d) => setJobs(d.jobs))
      .catch(() => {});
  }

  useEffect(load, []);

  async function queueJob() {
    if (!objective.trim()) {
      setNote("objective required");
      return;
    }
    try {
      await api("/v1/device-jobs", {
        method: "POST",
        body: JSON.stringify({ objective, envUrl: envUrl.trim() || undefined }),
      });
      setNote("job queued — a connected device will pick it up");
      setObjective("");
      load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "queue failed");
    }
  }

  return (
    <AppPage
      kicker="Devices"
      title="Your machines, our scheduler."
      hint={{
        steps: [
          "Run `veriflow device connect` on any machine with Chromium + an LLM key — it registers here and polls for work.",
          "Queue an objective below; the first online device claims it (FIFO) and the result shows up in Runs.",
        ],
      }}
    >
      {error ? <p className="error">{error}</p> : null}
      <h2>Registered devices</h2>
      {devices.length === 0 ? (
        <p className="empty">No devices yet — start one with `veriflow device connect`.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.status === "online" ? "● online" : "○ offline"}</td>
                <td>{d.lastHeartbeatAt.replace("T", " ").slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Queue work</h2>
      <label>
        Objective
        <input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Log in and check the billing page renders" />
      </label>
      <label>
        Start URL (optional)
        <input value={envUrl} onChange={(e) => setEnvUrl(e.target.value)} placeholder="https://staging.example.com" />
      </label>
      <button type="button" onClick={queueJob}>
        Queue job
      </button>
      {note ? <p className="empty">{note}</p> : null}

      <h2>Jobs</h2>
      {jobs.length === 0 ? (
        <p className="empty">No jobs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Objective</th>
              <th>Status</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.objective}</td>
                <td>{j.status}</td>
                <td>
                  {j.resultRunId ? (
                    <Link href={`/runs/${j.resultRunId}`} className="underline">
                      view run
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppPage>
  );
}
