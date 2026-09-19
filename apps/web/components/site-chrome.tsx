"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { VeriflowMark } from "@/components/veriflow-mark";

const appLinks = [
  ["/runs", "Runs"],
  ["/flows", "Flows"],
  ["/evidence", "Evidence"],
  ["/agent-test", "Agent tests"],
  ["/projects", "Projects"],
  ["/usage", "Usage"],
  ["/alerts", "Alerts"],
] as const;

export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const marketing = pathname === "/";

  return (
    <>
      <header className="grid border-b border-foreground/25 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex items-center justify-between gap-6 border-b border-foreground/25 px-5 py-4 md:border-b-0 md:border-r">
          <Link href="/" className="flex items-center gap-3 no-underline">
            <VeriflowMark />
            <span className="text-sm uppercase tracking-tight">Veriflow</span>
          </Link>
          <Link href="/login" className="font-mono text-[10px] uppercase no-underline md:hidden">
            Account
          </Link>
        </div>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 font-mono text-[10px] uppercase">
          {marketing ? (
            <>
              <a href="#product" className="no-underline">
                Product
              </a>
              <a href="#loop" className="no-underline">
                Loop
              </a>
              <a href="#pricing" className="no-underline">
                Pricing
              </a>
              <Link href="/runs" className="no-underline">
                Dashboard
              </Link>
              <Link href="/login" className="no-underline">
                Account
              </Link>
            </>
          ) : (
            <>
              {appLinks.map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className={`no-underline ${pathname.startsWith(href) ? "underline" : ""}`}
                >
                  {label}
                </Link>
              ))}
              <Link href="/login" className={`no-underline ${pathname === "/login" ? "underline" : ""}`}>
                Account
              </Link>
            </>
          )}
        </nav>
      </header>
      {marketing ? children : <main className="min-h-[70vh]">{children}</main>}
    </>
  );
}
