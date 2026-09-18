import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import JSZip from "jszip";
import type { EvidenceManifest, RunEvent, RunStatus } from "@veriflow/schema";
import { runPaths } from "@veriflow/store";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortValue(obj[key]);
    }
    return out;
  }
  return value;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function tamperHash(manifest: Omit<EvidenceManifest, "tamperHash">): string {
  return sha256(canonicalJson(manifest));
}

export function renderHtmlReport(input: {
  runId: string;
  objective: string;
  status: RunStatus;
  events: RunEvent[];
  envUrl?: string;
  tamperHash: string;
}): string {
  const rows = input.events
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.ts)}</td><td>${escapeHtml(e.type)}</td><td>${e.stepIndex ?? ""}</td><td><pre>${escapeHtml(JSON.stringify(e.payload, null, 2))}</pre></td></tr>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Veriflow evidence ${escapeHtml(input.runId)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #0f172a; }
    .meta { display: grid; grid-template-columns: 8rem 1fr; gap: 0.35rem 1rem; margin-bottom: 1.5rem; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; vertical-align: top; }
    th { background: #f1f5f9; text-align: left; }
    pre { white-space: pre-wrap; margin: 0; }
    .status { font-weight: 700; }
  </style>
</head>
<body>
  <h1>Veriflow evidence pack</h1>
  <div class="meta">
    <div>Run</div><div>${escapeHtml(input.runId)}</div>
    <div>Status</div><div class="status">${escapeHtml(input.status)}</div>
    <div>Objective</div><div>${escapeHtml(input.objective)}</div>
    <div>Env</div><div>${escapeHtml(input.envUrl ?? "")}</div>
    <div>Tamper hash</div><div><code>${escapeHtml(input.tamperHash)}</code></div>
  </div>
  <table>
    <thead><tr><th>Time</th><th>Type</th><th>Step</th><th>Payload</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

export async function writeEvidencePack(input: {
  runId: string;
  objective: string;
  status: RunStatus;
  events: RunEvent[];
  envUrl?: string;
  home?: string;
}): Promise<{ zipPath: string; reportPath: string; manifest: EvidenceManifest }> {
  const rp = runPaths(input.runId, input.home);
  const filesMeta: { path: string; sha256: string }[] = [];

  const eventsBody = input.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(rp.events, eventsBody, "utf8");

  const filePaths = listFilesRecursive(rp.dir).filter(
    (p) => !p.endsWith("evidence.testevidence") && !p.endsWith("manifest.json") && !p.endsWith("report.html"),
  );

  const zip = new JSZip();
  for (const abs of filePaths) {
    const rel = relative(rp.dir, abs).replaceAll("\\", "/");
    const buf = readFileSync(abs);
    filesMeta.push({ path: rel, sha256: sha256(buf) });
    zip.file(rel, buf);
  }

  const unsigned: Omit<EvidenceManifest, "tamperHash"> = {
    version: 1,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    objective: input.objective,
    status: input.status,
    envUrl: input.envUrl,
    stepCount: input.events.filter((e) => e.type === "act").length,
    files: filesMeta.sort((a, b) => a.path.localeCompare(b.path)),
  };
  const hash = tamperHash(unsigned);
  const manifest: EvidenceManifest = { ...unsigned, tamperHash: hash };

  const report = renderHtmlReport({
    runId: input.runId,
    objective: input.objective,
    status: input.status,
    events: input.events,
    envUrl: input.envUrl,
    tamperHash: hash,
  });
  writeFileSync(rp.report, report, "utf8");
  writeFileSync(rp.manifest, JSON.stringify(manifest, null, 2), "utf8");
  zip.file("report.html", report);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const zipBuf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(rp.evidence, zipBuf);
  return { zipPath: rp.evidence, reportPath: rp.report, manifest };
}
