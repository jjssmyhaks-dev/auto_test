"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { AppPage } from "@/components/app-page";

type CompareRow = {
  index: number;
  labelA?: string;
  labelB?: string;
  typeA?: string;
  typeB?: string;
  statusA?: string;
  statusB?: string;
  verdict: "same" | "changed" | "only_a" | "only_b";
  screenshotA?: string;
  screenshotB?: string;
};

type Comparison = {
  runIdA: string;
  runIdB: string;
  statusA?: string;
  statusB?: string;
  rows: CompareRow[];
  summary: { same: number; changed: number; onlyA: number; onlyB: number; similarity: number; statusFlipped: boolean };
};

const VERDICT_STYLE: Record<CompareRow["verdict"], string> = {
  same: "text-foreground/60",
  changed: "text-primary font-medium",
  only_a: "text-foreground/50",
  only_b: "text-foreground/50",
};

export default function RunComparePage() {
  return (
    <Suspense>
      <CompareInner />
    </Suspense>
  );
}

function CompareInner() {
  const params = useSearchParams();
  const [a, setA] = useState(params.get("a") ?? "");
  const [b, setB] = useState(params.get("b") ?? "");
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(aId: string, bId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ comparison: Comparison }>(`/v1/compare?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`);
      setData(res.comparison);
    } catch (e) {
      setError(e instanceof Error ? e.message : "compare failed");
    }
    setBusy(false);
  }

  useEffect(() => {
    if (params.get("a") && params.get("b")) void load(params.get("a")!, params.get("b")!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppPage
      kicker="Compare"
      title="Two runs, side by side."
      hint={{
        steps: [
          "Paste two run ids (or open this page from a run's detail page) to diff their step timelines.",
          "Green rows changed between runs; the similarity score tells you how much of the flow behaved identically.",
        ],
      }}
    >
      <div className="row flex flex-wrap items-end gap-3">
        <label className="text-sm">
          Run A
          <input value={a} onChange={(e) => setA(e.target.value)} placeholder="run_…" className="mt-1 block border border-foreground/25 bg-transparent px-2 py-1 font-mono text-xs" />
        </label>
        <label className="text-sm">
          Run B
          <input value={b} onChange={(e) => setB(e.target.value)} placeholder="run_…" className="mt-1 block border border-foreground/25 bg-transparent px-2 py-1 font-mono text-xs" />
        </label>
        <button type="button" onClick={() => a && b && load(a, b)} disabled={busy || !a || !b}>
          {busy ? "Diffing…" : "Compare"}
        </button>
      </div>
      {error ? <p className="error mt-3">{error}</p> : null}

      {data ? (
        <>
          <div className="mt-6 flex flex-wrap gap-4 text-sm">
            <span>
              Similarity <strong>{Math.round(data.summary.similarity * 100)}%</strong>
            </span>
            <span>
              A:{" "}
              <Link href={`/runs/${data.runIdA}`} className="underline">
                {data.runIdA.slice(0, 18)}…
              </Link>{" "}
              ({data.statusA ?? "?"})
            </span>
            <span>
              B:{" "}
              <Link href={`/runs/${data.runIdB}`} className="underline">
                {data.runIdB.slice(0, 18)}…
              </Link>{" "}
              ({data.statusB ?? "?"})
            </span>
            {data.summary.statusFlipped ? <span className="text-primary">⚠ run outcome flipped</span> : null}
            <span className="text-foreground/60">
              {data.summary.same} same · {data.summary.changed} changed · {data.summary.onlyA}/{data.summary.onlyB} only-in-A/B
            </span>
          </div>
          <table className="mt-4 w-full">
            <thead>
              <tr>
                <th>#</th>
                <th>Run A</th>
                <th>Run B</th>
                <th>Shots</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.index} className={VERDICT_STYLE[row.verdict]}>
                  <td className="font-mono text-xs">{row.index}</td>
                  <td>
                    <span className="font-mono text-[10px] uppercase">{row.typeA ?? "—"}</span> {row.labelA ?? "—"}{" "}
                    <span className="text-foreground/50">[{row.statusA ?? "—"}]</span>
                  </td>
                  <td>
                    <span className="font-mono text-[10px] uppercase">{row.typeB ?? "—"}</span> {row.labelB ?? "—"}{" "}
                    <span className="text-foreground/50">[{row.statusB ?? "—"}]</span>
                  </td>
                  <td className="whitespace-nowrap">
                    {row.screenshotA ? (
                      <a href={row.screenshotA} target="_blank" rel="noreferrer" className="mr-2 text-xs underline">
                        A ▸
                      </a>
                    ) : null}
                    {row.screenshotB ? (
                      <a href={row.screenshotB} target="_blank" rel="noreferrer" className="text-xs underline">
                        B ▸
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </AppPage>
  );
}
