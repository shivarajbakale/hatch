import readline from "node:readline/promises";
import pc from "picocolors";
import type { LogEvent } from "../aws/logs.js";

export const ui = {
  step: (msg: string) => console.log(`${pc.cyan("›")} ${msg}`),
  ok: (msg: string) => console.log(`${pc.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`${pc.yellow("!")} ${msg}`),
  fail: (msg: string) => console.error(`${pc.red("✗")} ${msg}`),
  dim: (msg: string) => console.log(pc.dim(msg)),
  plain: (msg: string) => console.log(msg),
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Pads columns to the widest cell. */
export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => stripAnsi(r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c + " ".repeat(widths[i]! - stripAnsi(c).length)).join("  ").trimEnd()).join("\n");
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export async function confirm(question: string, expected: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}

const REGION_SHORT: Record<string, string> = {
  "us-east-1": "use1",
  "us-east-2": "use2",
  "us-west-2": "usw2",
  "eu-west-1": "euw1",
  "ap-northeast-1": "apne1",
};

function colorStatus(status: number): string {
  const s = String(status);
  if (status >= 500) return pc.red(s);
  if (status >= 400) return pc.yellow(s);
  return pc.green(s);
}

/** One readable line per log event. hatch's JSON lines get columns; anything else prints raw. */
export function formatEvent(event: LogEvent, showRegion: boolean): string {
  const time = new Date(event.timestamp).toISOString().slice(11, 19);
  const region = showRegion ? pc.magenta((REGION_SHORT[event.region] ?? event.region).padEnd(5)) + " " : "";
  const text = event.message.trimEnd();
  let rec: Record<string, any> | undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") rec = parsed;
  } catch {}
  if (!rec || typeof rec.msg !== "string") return `${pc.dim(time)} ${region}${pc.dim(text)}`;

  const { ts: _ts, level, msg, requestId, region: _r, stage: _s, deploy, method, path, status, durationMs, coldStart, ...rest } = rec;
  const id = requestId ? pc.dim(String(requestId).slice(0, 8)) + " " : "";
  const dep = deploy ? pc.dim(String(deploy).slice(0, 7)) + " " : "";
  if (msg === "request" && typeof status === "number") {
    const cold = coldStart ? pc.blue(" cold") : "";
    return `${pc.dim(time)} ${region}${dep}${colorStatus(status)} ${String(method).padEnd(6)} ${path} ${pc.dim(`${durationMs}ms`)}${cold} ${id}`.trimEnd();
  }
  const lvl = level === "error" ? pc.red("ERROR") : level === "warn" ? pc.yellow("WARN ") : level === "debug" ? pc.dim("DEBUG") : pc.dim("INFO ");
  const extra = Object.keys(rest).length ? " " + pc.dim(JSON.stringify(rest)) : "";
  return `${pc.dim(time)} ${region}${dep}${lvl} ${id}${msg}${extra}`;
}

export function parseDuration(input: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(input.trim());
  if (!m) throw new Error(`--since must look like 30m, 2h or 1d, got "${input}"`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}
