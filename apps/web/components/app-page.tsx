import type { ReactNode } from "react";

export function AppPage({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="grid border-b border-foreground/25 lg:grid-cols-[19.4%_1fr]">
        <div className="border-b border-foreground/25 p-5 lg:border-b-0 lg:border-r lg:p-8">
          <p className="font-mono text-xs uppercase">{kicker}</p>
        </div>
        <div className="p-5 lg:p-8">
          <h1 className="max-w-3xl text-4xl leading-[0.95] md:text-5xl">{title}</h1>
        </div>
      </div>
      <div className="p-5 lg:max-w-5xl lg:p-10">{children}</div>
    </section>
  );
}
