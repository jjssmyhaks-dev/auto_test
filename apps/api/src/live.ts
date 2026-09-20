/**
 * Live run viewer: an in-memory frame bus connecting harness executions
 * (which POST screenshots) to SSE subscribers (the trace page's live pane).
 * Frames live for a few seconds and are keyed by run id; nothing persists.
 *
 * The API's runs are executed by the CLI/device agents — they ingest frames
 * via POST /v1/runs/:id/frames with the project token; browsers subscribe
 * via GET /v1/runs/:id/stream (EventSource).
 */

export interface LiveFrame {
  stepIndex: number;
  url: string;
  /** Raw PNG bytes. */
  png: Buffer;
  at: string;
}

type Listener = (frame: LiveFrame) => void;

const FRAME_TTL_MS = 10_000;

const buses = new Map<string, { frames: LiveFrame[]; listeners: Set<Listener> }>();

function bus(runId: string) {
  let b = buses.get(runId);
  if (!b) {
    b = { frames: [], listeners: new Set() };
    buses.set(runId, b);
  }
  return b;
}

export function pushFrame(runId: string, frame: LiveFrame) {
  const b = bus(runId);
  b.frames.push(frame);
  // Keep the tail small: a reconnecting viewer replays the last few frames.
  while (b.frames.length > 12) b.frames.shift();
  for (const l of b.listeners) {
    try {
      l(frame);
    } catch {
      /* a dead subscriber must not break the publisher */
    }
  }
}

export function subscribe(runId: string, listener: Listener): () => void {
  const b = bus(runId);
  b.listeners.add(listener);
  return () => {
    b.listeners.delete(listener);
    // Reclaim the bus once nobody listens and frames have expired — without
    // this, every SSE viewer leaks a Map entry for the life of the process.
    if (b.listeners.size === 0) {
      setTimeout(() => {
        const current = buses.get(runId);
        if (current && current.listeners.size === 0) buses.delete(runId);
      }, FRAME_TTL_MS).unref?.();
    }
  };
}

export function recentFrames(runId: string): LiveFrame[] {
  const b = buses.get(runId);
  if (!b) return [];
  const cutoff = Date.now() - FRAME_TTL_MS;
  // Drop expired frames lazily.
  b.frames = b.frames.filter((f) => new Date(f.at).getTime() >= cutoff);
  return [...b.frames];
}

export function closeBus(runId: string) {
  buses.delete(runId);
}

/** Dev/test helper: clear every bus. */
export function resetLiveBuses() {
  buses.clear();
}
