import { parseSync } from "oxc-parser";

export type Node = { type: string; start: number; end: number; [key: string]: any };

export function parse(file: string, source: string): { program: Node; errors: unknown[] } {
  const result = parseSync(file, source, { sourceType: "module" });
  return { program: result.program as unknown as Node, errors: result.errors };
}

/** Depth-first walk. `visit` gets each node and its parent chain (nearest last). */
export function walk(node: unknown, visit: (node: Node, parents: Node[]) => void, parents: Node[] = []): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parents);
    return;
  }
  const n = node as Node;
  if (typeof n.type !== "string") return;
  visit(n, parents);
  const next = [...parents, n];
  for (const [key, value] of Object.entries(n)) {
    if (key === "start" || key === "end" || key === "type") continue;
    if (value && typeof value === "object") walk(value, visit, next);
  }
}

/** 1-based line and column for a character offset. */
export function lineCol(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last };
}

/** Returns the string value of a string literal or a template literal with no expressions. */
export function staticString(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value?.cooked;
  return undefined;
}
