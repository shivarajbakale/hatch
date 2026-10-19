import fs from "node:fs";
import path from "node:path";
import { lineCol, parse, walk, type Node } from "./ast.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  rule: string;
  message: string;
  fix: string;
}

const FS_WRITES = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "mkdir", "mkdirSync"]);
const SOCKET_PACKAGES = new Set(["socket.io", "ws", "uWebSockets.js", "sockjs"]);
const NATIVE_PACKAGES = ["sharp", "bcrypt", "canvas", "better-sqlite3", "sqlite3", "argon2", "node-sass"];

function finding(file: string, source: string, node: Node, severity: Severity, rule: string, message: string, fix: string): Finding {
  return { file, line: lineCol(source, node.start).line, severity, rule, message, fix };
}

/** Scans one file for patterns that break when the server runs as many short-lived instances. */
export function checkSource(file: string, source: string): Finding[] {
  const out: Finding[] = [];
  const { program } = parse(file, source);

  for (const stmt of program.body as Node[]) {
    if (stmt.type === "ImportDeclaration" && SOCKET_PACKAGES.has(stmt.source.value)) {
      out.push(finding(file, source, stmt, "warn", "websockets", `imports ${stmt.source.value}`, "Lambda Web Functions docs don't cover WebSockets yet. Test it, or move realtime to API Gateway WebSockets."));
    }
    // Module-level Map/Set/array used as a cache or session store.
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations as Node[]) {
        const init = decl.init as Node | undefined;
        if (init?.type === "NewExpression" && init.callee.type === "Identifier" && ["Map", "Set", "WeakMap"].includes(init.callee.name)) {
          out.push(finding(file, source, decl, "warn", "memory-state", `module-level ${init.callee.name} "${decl.id.name ?? "?"}"`, "Each instance and region has its own copy, and it is lost on shutdown. Use kv() for shared state."));
        }
      }
    }
  }

  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as Node;
    const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : undefined;
    if (!name) return;
    if (name === "setInterval") {
      out.push(finding(file, source, node, "warn", "timers", "setInterval in server code", "Environments can be frozen between requests. Use a scheduled job instead (cron() is on the roadmap)."));
    } else if (FS_WRITES.has(name) && callee.type === "MemberExpression") {
      out.push(finding(file, source, node, "warn", "local-disk", `${name}() writes to local disk`, "Files don't persist across instances or deploys. Store them in S3."));
    } else if (name === "listen" && callee.type === "MemberExpression" && node.arguments.length > 0) {
      out.push(finding(file, source, node, "error", "listen", "app.listen() binds a fixed port", "Lambda sets the address in AWS_LAMBDA_HTTP_ENDPOINT. Replace with serve(app) from \"hatch\"."));
    } else if (callee.type === "Identifier" && name === "require" && SOCKET_PACKAGES.has(node.arguments[0]?.value)) {
      out.push(finding(file, source, node, "warn", "websockets", `requires ${node.arguments[0].value}`, "Lambda Web Functions docs don't cover WebSockets yet."));
    }
  });
  return out;
}

export function checkDependencies(pkg: { dependencies?: Record<string, string> }): Finding[] {
  const deps = Object.keys(pkg.dependencies ?? {});
  return NATIVE_PACKAGES.filter((p) => deps.includes(p)).map((p) => ({
    file: "package.json",
    line: 1,
    severity: "info" as const,
    rule: "native-module",
    message: `${p} has native code`,
    fix: "Lambda Web Functions run on Arm64. hatch builds on your machine, so make sure the linux-arm64 binary is bundled (or deploy from CI on arm64).",
  }));
}

const IGNORED_DIRS = new Set(["node_modules", ".hatch", "dist", ".git", "build", ".next", "coverage"]);

export function listSourceFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full, base));
    else if (/\.(m|c)?(t|j)sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) && !entry.name.endsWith(".d.ts") && !entry.name.startsWith("hatch.config.")) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

export function doctor(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of listSourceFiles(root)) {
    findings.push(...checkSource(file, fs.readFileSync(path.join(root, file), "utf8")));
  }
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) findings.push(...checkDependencies(JSON.parse(fs.readFileSync(pkgPath, "utf8"))));
  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}
