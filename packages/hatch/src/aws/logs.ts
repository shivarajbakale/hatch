import { FilterLogEventsCommand, StartLiveTailCommand } from "@aws-sdk/client-cloudwatch-logs";
import { aws, isNotFound } from "./clients.js";

export interface LogFilter {
  /** "5xx", "4xx", or an exact code like "404". */
  status?: string;
  requestId?: string;
  path?: string;
  level?: string;
  deploy?: string;
}

export function logGroupName(functionName: string): string {
  return `/aws/lambda/web/${functionName}`;
}

export function logGroupArn(region: string, account: string, functionName: string): string {
  return `arn:aws:logs:${region}:${account}:log-group:${logGroupName(functionName)}`;
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

/** Builds a CloudWatch JSON filter pattern over hatch's structured log fields. */
export function filterPattern(filter: LogFilter): string | undefined {
  const parts: string[] = [];
  if (filter.status) {
    const s = filter.status.toLowerCase();
    const m = /^([1-5])xx$/.exec(s);
    if (m) parts.push(`$.status >= ${m[1]}00 && $.status < ${Number(m[1]) + 1}00`);
    else if (/^\d{3}$/.test(s)) parts.push(`$.status = ${s}`);
    else throw new Error(`--status must look like 5xx or 404, got "${filter.status}"`);
  }
  if (filter.requestId) parts.push(`$.requestId = ${quote(filter.requestId)}`);
  if (filter.path) parts.push(`$.path = ${quote(filter.path)}`);
  if (filter.level) parts.push(`$.level = ${quote(filter.level.toLowerCase())}`);
  if (filter.deploy) parts.push(`$.deploy = ${quote(filter.deploy)}`);
  if (!parts.length) return undefined;
  return `{ ${parts.length === 1 ? parts[0] : parts.map((p) => `(${p})`).join(" && ")} }`;
}

export interface LogEvent {
  region: string;
  timestamp: number;
  message: string;
}

/** Hard cap on events read per region by `--since`, so a busy window can't page forever. */
const MAX_SCAN = 20_000;

/** The newest `limit` events in the window, from every region, merged by time. */
export async function queryLogs(regions: string[], functionName: string, startTime: number, filter: LogFilter, limit = 500): Promise<LogEvent[]> {
  const pattern = filterPattern(filter);
  const perRegion = await Promise.all(
    regions.map(async (region) => {
      const events: LogEvent[] = [];
      let nextToken: string | undefined;
      try {
        // FilterLogEvents pages oldest-first, so read the whole window and keep the newest at the end.
        do {
          const page = await aws.logs(region).send(
            new FilterLogEventsCommand({ logGroupName: logGroupName(functionName), startTime, filterPattern: pattern, nextToken }),
          );
          for (const e of page.events ?? []) events.push({ region, timestamp: e.timestamp ?? 0, message: e.message ?? "" });
          nextToken = page.nextToken;
        } while (nextToken && events.length < MAX_SCAN);
      } catch (err) {
        if (!isNotFound(err)) throw err; // No log group yet: nothing has run in this region.
      }
      return events.slice(-limit);
    }),
  );
  return perRegion
    .flat()
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);
}

/**
 * Streams new events from every region until `signal` aborts. Regions without a log group yet are
 * reported through `onMissing` and skipped; any other failure stops every region's stream.
 * Live Tail sessions last up to 3 hours.
 */
export async function tailLogs(
  regions: string[],
  account: string,
  functionName: string,
  filter: LogFilter,
  onEvent: (event: LogEvent) => void,
  signal: AbortSignal,
  onMissing: (region: string) => void = () => {},
): Promise<void> {
  const pattern = filterPattern(filter);
  const inner = new AbortController();
  const stopAll = () => inner.abort();
  signal.addEventListener("abort", stopAll, { once: true });
  try {
    await Promise.all(
      regions.map(async (region) => {
        try {
          const out = await aws.logs(region).send(
            new StartLiveTailCommand({ logGroupIdentifiers: [logGroupArn(region, account, functionName)], logEventFilterPattern: pattern }),
            { abortSignal: inner.signal },
          );
          if (!out.responseStream) return;
          for await (const chunk of out.responseStream) {
            if (inner.signal.aborted) break;
            for (const r of chunk.sessionUpdate?.sessionResults ?? []) {
              onEvent({ region, timestamp: r.timestamp ?? Date.now(), message: r.message ?? "" });
            }
          }
        } catch (err) {
          if (inner.signal.aborted) return; // Ctrl-C, or another region already failed.
          if (isNotFound(err)) {
            onMissing(region);
            return;
          }
          stopAll();
          throw err;
        }
      }),
    );
  } finally {
    signal.removeEventListener("abort", stopAll);
  }
}
