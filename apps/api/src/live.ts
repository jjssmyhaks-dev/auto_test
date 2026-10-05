/**
 * Live run viewer: a frame bus connecting harness executions (which POST
 * screenshots) to SSE subscribers (the trace page's live pane).
 *
 * Two backends:
 *  - MemoryLiveBus: per-process, zero infrastructure. Correct for a single
 *    API replica; frames live for a few seconds and are keyed by run id.
 *  - PgLiveBus: multi-replica safe. Frames are persisted to a small Postgres
 *    table and fanned out via LISTEN/NOTIFY, so a subscriber connected to
 *    replica A receives frames pushed to replica B. PNGs ride in the table
 *    (notifications carry only the row id — under the 8KB NOTIFY limit).
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

export type LiveListener = (frame: LiveFrame) => void;

import type pg from "pg";

export interface LiveBus {
  pushFrame(runId: string, frame: LiveFrame): Promise<void> | void;
  subscribe(runId: string, listener: LiveListener): (() => void) | Promise<() => void>;
  recentFrames(runId: string): LiveFrame[] | Promise<LiveFrame[]>;
  close?(): Promise<void>;
}

const FRAME_TTL_MS = 10_000;
const CHANNEL = "veriflow_live";

// ---------------------------------------------------------------------------
// Memory bus (default; single replica)
// ---------------------------------------------------------------------------

export class MemoryLiveBus implements LiveBus {
  private readonly buses = new Map<string, { frames: LiveFrame[]; listeners: Set<LiveListener> }>();

  private bus(runId: string) {
    let b = this.buses.get(runId);
    if (!b) {
      b = { frames: [], listeners: new Set() };
      this.buses.set(runId, b);
    }
    return b;
  }

  pushFrame(runId: string, frame: LiveFrame) {
    const b = this.bus(runId);
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

  subscribe(runId: string, listener: LiveListener): () => void {
    const b = this.bus(runId);
    b.listeners.add(listener);
    return () => {
      b.listeners.delete(listener);
      // Reclaim the bus once nobody listens and frames have expired — without
      // this, every SSE viewer leaks a Map entry for the life of the process.
      if (b.listeners.size === 0) {
        setTimeout(() => {
          const current = this.buses.get(runId);
          if (current && current.listeners.size === 0) this.buses.delete(runId);
        }, FRAME_TTL_MS).unref?.();
      }
    };
  }

  recentFrames(runId: string): LiveFrame[] {
    const b = this.buses.get(runId);
    if (!b) return [];
    const cutoff = Date.now() - FRAME_TTL_MS;
    // Drop expired frames lazily.
    b.frames = b.frames.filter((f) => new Date(f.at).getTime() >= cutoff);
    return [...b.frames];
  }

  reset() {
    this.buses.clear();
  }

  closeRun(runId: string) {
    this.buses.delete(runId);
  }
}

/** Shared default (single-replica) bus. */
const memoryLiveBus = new MemoryLiveBus();
export const sharedLiveBus: LiveBus = memoryLiveBus;

// Module-level helpers kept for back-compat with existing imports/tests.
export function pushFrame(runId: string, frame: LiveFrame) {
  memoryLiveBus.pushFrame(runId, frame);
}
export function subscribe(runId: string, listener: LiveListener): () => void {
  return memoryLiveBus.subscribe(runId, listener);
}
export function recentFrames(runId: string): LiveFrame[] {
  return memoryLiveBus.recentFrames(runId);
}
export function closeBus(runId: string) {
  memoryLiveBus.closeRun(runId);
}
/** Dev/test helper: clear every bus. */
export function resetLiveBuses() {
  memoryLiveBus.reset();
}

// ---------------------------------------------------------------------------
// Postgres bus (multi-replica)
// ---------------------------------------------------------------------------

export class PgLiveBus implements LiveBus {
  private readonly local = new Map<string, Set<LiveListener>>();
  private listenClient: { query: (sql: string) => Promise<unknown>; on: (ev: string, cb: (msg: unknown) => void) => void; release: () => void } | undefined;
  private connecting: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly framesPerRun = 12,
  ) {}

  private async ensureListening(): Promise<void> {
    if (this.listenClient || this.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      // A dedicated client holds the LISTEN; pool clients are round-robin and
      // would miss notifications for other connections.
      const client = (await this.pool.connect()) as unknown as {
        query: (sql: string) => Promise<unknown>;
        on: (ev: string, cb: (msg: unknown) => void) => void;
        release: () => void;
      };
      client.on("notification", (msg: unknown) => {
        const payload = (msg as { payload?: string }).payload;
        if (!payload) return;
        let parsed: { runId?: string; id?: string };
        try {
          parsed = JSON.parse(payload) as { runId?: string; id?: string };
        } catch {
          return;
        }
        if (!parsed.runId || !parsed.id) return;
        void this.deliver(parsed.runId, parsed.id);
      });
      client.on("error", () => {
        // Drop the client; the next push/subscribe re-establishes LISTEN.
        this.listenClient = undefined;
        try {
          client.release();
        } catch {
          /* already released */
        }
      });
      await client.query(`LISTEN ${CHANNEL}`);
      this.listenClient = client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async deliver(runId: string, id: string) {
    const rows = await this.pool.query(`SELECT step_index, url, png, at FROM live_frames WHERE id = $1 AND run_id = $2`, [id, runId]);
    const row = rows.rows[0];
    if (!row) return;
    const frame: LiveFrame = {
      stepIndex: Number(row.step_index),
      url: String(row.url ?? ""),
      png: Buffer.from(String(row.png ?? ""), "base64"),
      at: String(row.at),
    };
    for (const l of this.local.get(runId) ?? []) {
      try {
        l(frame);
      } catch {
        /* a dead subscriber must not break the publisher */
      }
    }
  }

  async pushFrame(runId: string, frame: LiveFrame): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO live_frames (run_id, step_index, url, png, at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [runId, frame.stepIndex, frame.url, frame.png.toString("base64"), frame.at],
    );
    const id = res.rows[0]?.id;
    // Trim per-run tail + expire old frames globally (keeps the table small).
    await this.pool
      .query(
        `DELETE FROM live_frames WHERE run_id = $1 AND id NOT IN (SELECT id FROM live_frames WHERE run_id = $1 ORDER BY id DESC LIMIT $2)`,
        [runId, this.framesPerRun],
      )
      .catch(() => undefined);
    if (Math.random() < 0.02) {
      await this.pool.query(`DELETE FROM live_frames WHERE at < $1`, [new Date(Date.now() - 30 * 60_000).toISOString()]).catch(() => undefined);
    }
    // Deliver locally first (the pushing replica usually holds the subscriber),
    // then notify the fleet — the payload is just the row id, far under the
    // 8KB NOTIFY limit.
    for (const l of this.local.get(runId) ?? []) {
      try {
        l(frame);
      } catch {
        /* ignore dead subscribers */
      }
    }
    if (typeof id !== "undefined") {
      await this.pool.query(`SELECT pg_notify($1, $2)`, [CHANNEL, JSON.stringify({ runId, id: String(id) })]).catch(() => undefined);
    }
  }

  async subscribe(runId: string, listener: LiveListener): Promise<() => void> {
    await this.ensureListening();
    let set = this.local.get(runId);
    if (!set) {
      set = new Set();
      this.local.set(runId, set);
    }
    set.add(listener);
    return () => {
      const s = this.local.get(runId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.local.delete(runId);
    };
  }

  async recentFrames(runId: string): Promise<LiveFrame[]> {
    const res = await this.pool.query(`SELECT step_index, url, png, at FROM live_frames WHERE run_id = $1 ORDER BY id DESC LIMIT $2`, [runId, this.framesPerRun]);
    return res.rows
      .map((row) => ({
        stepIndex: Number(row.step_index),
        url: String(row.url ?? ""),
        png: Buffer.from(String(row.png ?? ""), "base64"),
        at: String(row.at),
      }))
      .reverse();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.listenClient) {
      try {
        this.listenClient.release();
      } catch {
        /* already released */
      }
      this.listenClient = undefined;
    }
    this.local.clear();
  }
}
