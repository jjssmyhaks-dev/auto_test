"use client";

import { useEffect, useState } from "react";

export function ApiHealth() {
  const [health, setHealth] = useState("checking API…");
  useEffect(() => {
    fetch((process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787") + "/health")
      .then((r) => r.json())
      .then((j) => setHealth(`API ok (${j.store}, blobs ${j.blobs})`))
      .catch(() => setHealth("API offline — start apps/api on :8787"));
  }, []);
  return <p className="font-mono text-[10px] uppercase leading-tight text-foreground/70">{health}</p>;
}
