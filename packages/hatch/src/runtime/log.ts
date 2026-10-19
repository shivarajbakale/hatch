import { currentContext, region, runtimeInfo } from "./context.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT = /pass(word)?|secret|token|authorization|cookie|api[-_]?key/i;

function minLevel(): number {
  const env = (process.env.HATCH_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[env] ?? LEVELS.info;
}

function serializeError(err: Error): Record<string, unknown> {
  return { name: err.name, message: err.message, stack: err.stack };
}

/**
 * Replaces values of sensitive-looking keys, at any depth, with "[redacted]". Fails closed: past the
 * depth limit or on a cycle it returns a marker, never the raw object.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  if (depth >= 8) return "[truncated]";
  seen.add(value);
  const out: unknown = Array.isArray(value)
    ? value.map((v) => redact(v, depth + 1, seen))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REDACT.test(k) ? "[redacted]" : redact(v, depth + 1, seen)]));
  seen.delete(value);
  return out;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

type Sink = (record: LogRecord) => void;

const jsonSink: Sink = (record) => {
  process.stdout.write(JSON.stringify(record) + "\n");
};

const prettySink: Sink = (record) => {
  const { ts, level, msg, requestId, region: _r, stage: _s, app: _a, deploy: _d, ...rest } = record;
  const time = new Date(ts).toLocaleTimeString("en-GB");
  const tag = level === "error" ? "ERR" : level === "warn" ? "WRN" : level === "debug" ? "DBG" : "   ";
  const id = requestId ? ` ${String(requestId).slice(0, 8)}` : "";
  const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
  process.stdout.write(`${time} ${tag}${id} ${msg}${extra}\n`);
};

let sink: Sink | undefined;

/** Swap the output sink; used by tests. */
export function setLogSink(next: Sink | undefined): void {
  sink = next;
}

function write(level: LogLevel, msg: string, fields?: unknown): void {
  if (LEVELS[level] < minLevel()) return;
  const ctx = currentContext();
  const base: LogRecord = {
    ts: new Date().toISOString(),
    level,
    msg,
    requestId: ctx?.requestId,
    region: region.current,
    stage: runtimeInfo.stage,
    deploy: runtimeInfo.deployId,
  };
  let extra: Record<string, unknown> = {};
  if (fields instanceof Error) extra = { err: serializeError(fields) };
  else if (fields && typeof fields === "object") extra = redact(fields) as Record<string, unknown>;
  else if (fields !== undefined) extra = { value: fields };
  const record = { ...base, ...extra };
  for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
  (sink ?? (runtimeInfo.isDev ? prettySink : jsonSink))(record);
}

export const log = {
  debug: (msg: string, fields?: unknown) => write("debug", msg, fields),
  info: (msg: string, fields?: unknown) => write("info", msg, fields),
  warn: (msg: string, fields?: unknown) => write("warn", msg, fields),
  error: (msg: string, fields?: unknown) => write("error", msg, fields),
};
