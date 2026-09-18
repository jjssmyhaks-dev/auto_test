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
