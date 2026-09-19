import type { ReactNode } from "react";
import { PageHint, type PageHintContent } from "@/components/page-hint";

export function AppPage({
  kicker,
  title,
  hint,
  children,
}: {
  kicker: string;
  title: string;
  hint?: PageHintContent;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="grid border-b border-foreground/25 lg:grid-cols-[19.4%_1fr]">
        <div className="flex items-start justify-between border-b border-foreground/25 p-5 lg:border-b-0 lg:border-r lg:p-8">
          <p className="font-mono text-xs uppercase">{kicker}</p>
          {hint ? (
            <span className="lg:hidden">
              <PageHint hint={hint} />
            </span>
          ) : null}
        </div>
        <div className="flex items-start justify-between gap-4 p-5 lg:p-8">
          <h1 className="max-w-3xl text-4xl leading-[0.95] md:text-5xl">{title}</h1>
          {hint ? (
            <span className="hidden shrink-0 pt-2 lg:block">
              <PageHint hint={hint} />
            </span>
          ) : null}
        </div>
      </div>
      <div className="p-5 lg:max-w-5xl lg:p-10">{children}</div>
    </section>
  );
}
