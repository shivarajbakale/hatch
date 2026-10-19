import fs from "node:fs";
import path from "node:path";
import { lineCol, parse, staticString, walk, type Node } from "./ast.js";

export interface Resources {
  kv: string[];
  secrets: string[];
  warnings: string[];
}

const RESOURCE_FUNCTIONS = new Set(["kv", "secret"]);

/** Finds `kv("name")` and `secret("NAME")` calls on functions imported from "hatch". */
export function analyzeSource(file: string, source: string): Resources {
  const { program } = parse(file, source);
  const local = new Map<string, string>(); // local identifier -> exported name
  const namespaces = new Set<string>(); // import * as h from "hatch"
  for (const stmt of program.body as Node[]) {
    if (stmt.type !== "ImportDeclaration" || stmt.source.value !== "hatch") continue;
    for (const spec of stmt.specifiers as Node[]) {
      if (spec.type === "ImportSpecifier") {
        const imported = spec.imported.name ?? spec.imported.value;
        if (RESOURCE_FUNCTIONS.has(imported)) local.set(spec.local.name, imported);
      } else if (spec.type === "ImportNamespaceSpecifier") {
        namespaces.add(spec.local.name);
      }
    }
  }

  const kv = new Set<string>();
  const secrets = new Set<string>();
  const warnings: string[] = [];
  if (local.size === 0 && namespaces.size === 0) return { kv: [], secrets: [], warnings };

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as Node;
    let fn: string | undefined;
    if (callee.type === "Identifier") fn = local.get(callee.name);
    else if (
      callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      namespaces.has(callee.object.name) &&
      callee.property.type === "Identifier" &&
      RESOURCE_FUNCTIONS.has(callee.property.name)
    ) {
      fn = callee.property.name;
    }
    if (!fn) return;
    const name = staticString(node.arguments[0]);
    if (name === undefined) {
      const { line } = lineCol(source, node.start);
      warnings.push(`${file}:${line} ${fn}() needs a string literal name so hatch can create it at deploy time`);
      return;
    }
    (fn === "kv" ? kv : secrets).add(name);
  });

  return { kv: [...kv].sort(), secrets: [...secrets].sort(), warnings };
}

/** Analyzes every first-party file (outside node_modules) that went into the bundle. */
export function analyzeFiles(root: string, files: string[]): Resources {
  const kv = new Set<string>();
  const secrets = new Set<string>();
  const warnings: string[] = [];
  for (const file of files) {
    if (file.includes("node_modules") || !/\.(m|c)?(t|j)sx?$/.test(file)) continue;
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs)) continue;
    const result = analyzeSource(path.relative(root, abs), fs.readFileSync(abs, "utf8"));
    result.kv.forEach((n) => kv.add(n));
    result.secrets.forEach((n) => secrets.add(n));
    warnings.push(...result.warnings);
  }
  return { kv: [...kv].sort(), secrets: [...secrets].sort(), warnings };
}
