export interface A11yNode {
  ref: string;
  role: string;
  name: string;
  selector: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface A11ySnapshot {
  tree: string;
  nodes: A11yNode[];
}

export function compactTree(nodes: A11yNode[], limit = 80): string {
  return nodes
    .slice(0, limit)
    .map((n) => `@${n.ref} [${n.role}] ${n.name}`.trim())
    .join("\n");
}
