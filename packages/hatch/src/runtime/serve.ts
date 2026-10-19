import { randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { runWithContext } from "./context.js";
import { log } from "./log.js";

/** Anything with a WHATWG `fetch(request)` method: Hono, Elysia-on-Node, itty-router, plain objects. */
export interface FetchApp {
  fetch: (request: Request, ...rest: any[]) => Response | Promise<Response>;
}

/** A Node request listener: Express, Connect, Koa's `app.callback()`, or a plain function. */
export type NodeHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export type ServeTarget = FetchApp | NodeHandler;

export interface ServeOptions {
  /** Overrides AWS_LAMBDA_HTTP_ENDPOINT / PORT. Mostly for tests. */
  port?: number;
  host?: string;
  /** Log one line per request. Default true. */
  requestLog?: boolean;
  /** On shutdown, how long in-flight requests (streams included) get before their sockets are closed. Default 8000. */
  shutdownGraceMs?: number;
  onListen?: (address: { host: string; port: number }) => void;
}

/**
 * Lambda Web Functions tell the server where to bind with AWS_LAMBDA_HTTP_ENDPOINT ("host:port").
 * Locally we fall back to PORT, then 3000.
 */
export function resolveListenAddress(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const endpoint = env.AWS_LAMBDA_HTTP_ENDPOINT;
  if (endpoint) {
    const idx = endpoint.lastIndexOf(":");
    if (idx > 0) {
      const port = Number(endpoint.slice(idx + 1));
      if (Number.isInteger(port) && port > 0) return { host: endpoint.slice(0, idx), port };
    }
    throw new Error(`AWS_LAMBDA_HTTP_ENDPOINT must look like host:port, got "${endpoint}"`);
  }
  return { host: env.HOST ?? "127.0.0.1", port: Number(env.PORT ?? 3000) };
}

function isFetchApp(target: ServeTarget): target is FetchApp {
  return typeof (target as FetchApp).fetch === "function";
}

function toRequest(req: http.IncomingMessage, host: string): Request {
  // Behind hatch's CloudFront front door, Host is the function's own domain; the viewer's domain
  // arrives in x-forwarded-host (set by a CloudFront Function, so viewers can't spoof it there).
  const forwarded = process.env.HATCH_FRONT_DOOR ? req.headers["x-forwarded-host"] : undefined;
  // Not `new URL(req.url, base)`: a raw path like "//api/users" would be read as a host.
  const url = new URL(typeof forwarded === "string" && forwarded ? `https://${forwarded}` : `http://${req.headers.host ?? host}`);
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  url.pathname = q === -1 ? raw : raw.slice(0, q);
  url.search = q === -1 ? "" : raw.slice(q);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // Required by Node's fetch when the body is a stream.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function writeResponse(response: Response, res: http.ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText, headers);
  if (!response.body) {
    res.end();
    return;
  }
  // Stream so LLM token streams and SSE reach the client as they are produced.
  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(response.body as any);
    body.on("error", reject);
    res.on("close", () => {
      body.destroy();
      resolve();
    });
    body.pipe(res);
  });
}

function fetchListener(app: FetchApp, host: string): NodeHandler {
  return (req, res) => {
    Promise.resolve()
      .then(() => app.fetch(toRequest(req, host)))
      .then((response) => writeResponse(response, res))
      .catch((err) => {
        log.error("unhandled error", err);
        if (res.headersSent) {
          // Part of the body is already out; appending text would corrupt it. Cut the connection.
          res.destroy(err);
          return;
        }
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
      });
  };
}

let coldStart = true;

function instrument(handler: NodeHandler, requestLog: boolean): NodeHandler {
  return (req, res) => {
    const header = req.headers["x-amzn-request-id"] ?? req.headers["x-request-id"];
    const requestId = (Array.isArray(header) ? header[0] : header) ?? randomUUID();
    const ctx = {
      requestId,
      method: req.method ?? "GET",
      path: (req.url ?? "/").split("?")[0]!,
      startedAt: performance.now(),
    };
    const isCold = coldStart;
    coldStart = false;
    res.setHeader("x-request-id", requestId);
    if (requestLog) {
      res.on("finish", () => {
        runWithContext(ctx, () =>
          log.info("request", {
            method: ctx.method,
            path: ctx.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - ctx.startedAt),
            coldStart: isCold,
          }),
        );
      });
    }
    runWithContext(ctx, () => handler(req, res));
  };
}

export interface Served {
  server: http.Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts an HTTP server for a fetch-style app (Hono) or a Node handler (Express),
 * bound where Lambda Web Functions expects it. Use it instead of `app.listen()`.
 */
export function serve(target: ServeTarget, options: ServeOptions = {}): Promise<Served> {
  const resolved = resolveListenAddress();
  const host = options.host ?? resolved.host;
  const port = options.port ?? resolved.port;
  const base = isFetchApp(target) ? fetchListener(target, host) : target;
  const server = http.createServer(instrument(base, options.requestLog ?? true));
  // Lambda Web Functions run up to 128 requests per environment; keep sockets alive for reuse.
  server.keepAliveTimeout = 65_000;

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      // An open SSE or LLM stream would otherwise hold shutdown forever.
      setTimeout(() => server.closeAllConnections(), options.shutdownGraceMs ?? 8000).unref();
    });

  const onSignal = () => {
    log.info("shutting down");
    close().then(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  server.on("close", () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      options.onListen?.({ host, port: actualPort });
      log.info("listening", { host, port: actualPort });
      resolve({ server, host, port: actualPort, close });
    });
  });
}
