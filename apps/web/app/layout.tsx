import type { ReactNode } from "react";
import type { Metadata } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SiteChrome } from "@/components/site-chrome";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veriflow — Vision, verified.",
  description:
    "Local-first vision browser testing. CLI runs, evidence packs, MCP, and agent tests — with Free, Starter, and Team cloud quotas.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider>
          <SiteChrome>{children}</SiteChrome>
        </TooltipProvider>
      </body>
    </html>
  );
}
