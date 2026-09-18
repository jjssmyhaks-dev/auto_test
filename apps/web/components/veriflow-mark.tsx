export function VeriflowMark({ className = "" }: { className?: string }) {
  return (
    <span className={`grid grid-cols-3 gap-[2px] ${className}`} aria-hidden="true">
      <i className="h-2 w-2 bg-foreground" />
      <i className="mt-2 h-2 w-2 bg-foreground" />
      <i className="h-2 w-2 bg-foreground" />
    </span>
  );
}
