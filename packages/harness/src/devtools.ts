import type { Page } from "playwright";

export interface NetworkLog {
  url: string;
  method: string;
  status?: number;
  type?: string;
}

export interface ConsoleLog {
  type: string;
  text: string;
}

export interface DevtoolsCapture {
  network: NetworkLog[];
  console: ConsoleLog[];
  performance: Record<string, unknown>[];
}

export function emptyCapture(): DevtoolsCapture {
  return { network: [], console: [], performance: [] };
}

/** CDP network/console/performance when enabled; Playwright events as fallback. */
export async function attachDevtoolsCapture(page: Page): Promise<DevtoolsCapture> {
  const capture = emptyCapture();
  page.on("request", (req) => {
    capture.network.push({ url: req.url(), method: req.method() });
  });
  page.on("response", (res) => {
    const entry = [...capture.network].reverse().find((n) => n.url === res.url() && n.status === undefined);
    if (entry) entry.status = res.status();
    else capture.network.push({ url: res.url(), method: res.request().method(), status: res.status() });
  });
  page.on("console", (msg) => {
    capture.console.push({ type: msg.type(), text: msg.text() });
  });

  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Runtime.enable");
    await session.send("Performance.enable").catch(() => undefined);
    session.on("Network.responseReceived", (evt: { response: { url: string; status: number; mimeType?: string } }) => {
      capture.network.push({
        url: evt.response.url,
        method: "GET",
        status: evt.response.status,
        type: evt.response.mimeType,
      });
    });
    session.on("Runtime.consoleAPICalled", (evt: { type: string; args?: Array<{ value?: unknown; description?: string }> }) => {
      const text = (evt.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ");
      capture.console.push({ type: evt.type, text });
    });
    const metrics = await session.send("Performance.getMetrics").catch(() => undefined);
    if (metrics && "metrics" in metrics) {
      capture.performance.push(metrics as Record<string, unknown>);
    }
  } catch {
    /* headed/headless without CDP still has Playwright listeners */
  }
  return capture;
}

export function assertNetwork(capture: DevtoolsCapture, value: string): { ok: boolean; detail: string } {
  const hit = capture.network.some((n) => n.url.toLowerCase().includes(value.toLowerCase()));
  return { ok: hit, detail: hit ? `network matched ${value}` : `no request containing ${value}` };
}

export function assertConsole(capture: DevtoolsCapture, value: string): { ok: boolean; detail: string } {
  const hit = capture.console.some((c) => c.text.toLowerCase().includes(value.toLowerCase()));
  return { ok: hit, detail: hit ? `console matched ${value}` : `no console message containing ${value}` };
}

/** Spec 6.4: NL assertions over cookies / localStorage / page-load timing. */
export async function assertPageState(
  page: Page,
  check: "cookie_contains" | "local_storage" | "load_time_under",
  value: string,
): Promise<{ ok: boolean; detail: string }> {
  if (check === "cookie_contains") {
    const cookies = await page.context().cookies();
    const hit = cookies.find((c) => c.name.toLowerCase().includes(value.toLowerCase()));
    return hit
      ? { ok: true, detail: `cookie ${hit.name} present` }
      : { ok: false, detail: `no cookie name containing ${value} (have: ${cookies.map((c) => c.name).join(", ") || "none"})` };
  }
  if (check === "local_storage") {
    const entries = await page.evaluate(() => {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out.push(k);
      }
      return out;
    });
    const hit = entries.find((k) => k.toLowerCase().includes(value.toLowerCase()));
    return hit
      ? { ok: true, detail: `localStorage key ${hit} present` }
      : { ok: false, detail: `no localStorage key containing ${value} (have: ${entries.join(", ") || "none"})` };
  }
  // load_time_under: navigation timing via Performance API, value in milliseconds.
  const limitMs = Number(value);
  if (!Number.isFinite(limitMs) || limitMs <= 0) {
    return { ok: false, detail: `load_time_under needs a millisecond value, got ${value}` };
  }
  const loadMs = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav) return nav.loadEventEnd > 0 ? nav.loadEventEnd - nav.startTime : nav.domContentLoadedEventEnd - nav.startTime;
    const paint = performance.getEntriesByType("paint")[0] as PerformanceEntry | undefined;
    return paint ? paint.startTime : performance.now();
  });
  return {
    ok: loadMs <= limitMs,
    detail: `load took ${Math.round(loadMs)}ms (limit ${Math.round(limitMs)}ms)`,
  };
}
