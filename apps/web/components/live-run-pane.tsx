"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "@/lib/api";

/**
 * Live run pane: subscribes to the API's SSE frame stream and renders the
 * newest screenshot as it arrives — the reviewer watches the browser move
 * while the agent works. Frames replay on reconnect (last ~10s kept server-side).
 */
export function LiveRunPane({ runId, status }: { runId: string; status: string }) {
  const [frame, setFrame] = useState<{ pngBase64: string; url: string; stepIndex: number } | null>(null);
  const [live, setLive] = useState(false);
  const [framesSeen, setFramesSeen] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (status !== "running" && status !== "queued") return;
    const es = new EventSource(`${API_URL}/v1/runs/${runId}/stream`);
    esRef.current = es;
    es.addEventListener("hello", () => setLive(true));
    es.addEventListener("frame", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { pngBase64: string; url: string; stepIndex: number };
        setFrame(data);
        setFramesSeen((n) => n + 1);
      } catch {
        /* malformed frame — skip */
      }
    });
    es.onerror = () => setLive(false);
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [runId, status]);

  if (status !== "running" && status !== "queued") {
    return null;
  }

  return (
    <div className="border border-foreground/25">
      <div className="flex items-center justify-between border-b border-foreground/25 px-3 py-2">
        <span className="text-xs uppercase tracking-widest">Live</span>
        <span className={`text-xs ${live ? "text-green-600" : "text-foreground/50"}`}>
          {live ? "streaming" : "connecting…"} {framesSeen > 0 ? `· ${framesSeen} frames` : ""}
        </span>
      </div>
      {frame ? (
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/png;base64,${frame.pngBase64}`}
            alt={`Live frame at step ${frame.stepIndex}`}
            className="w-full"
          />
          <figcaption className="px-3 py-1.5 text-xs text-foreground/60">
            step {frame.stepIndex} · {frame.url || "…"}
          </figcaption>
        </figure>
      ) : (
        <p className="p-3 text-xs text-foreground/50">
          Waiting for the first frame — the runner pushes one per step.
        </p>
      )}
    </div>
  );
}
