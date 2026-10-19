import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kv, LocalKV, log, redact, resolveListenAddress, secret, serve, setLogSink, type LogRecord, type Served } from "../src/runtime/index.js";

let records: LogRecord[] = [];
let served: Served | undefined;

beforeEach(() => {
  records = [];
  setLogSink((r) => records.push(r));
});

afterEach(async () => {
  await served?.close();
  served = undefined;
  setLogSink(undefined);
});

const url = (p: string) => `http://127.0.0.1:${served!.port}${p}`;

describe("resolveListenAddress", () => {
  it("binds where Lambda says", () => {
    expect(resolveListenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: "169.254.100.1:9001" })).toEqual({ host: "169.254.100.1", port: 9001 });
  });
  it("falls back to PORT locally", () => {
    expect(resolveListenAddress({ PORT: "4000" })).toEqual({ host: "127.0.0.1", port: 4000 });
  });
  it("rejects a malformed endpoint", () => {
    expect(() => resolveListenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: "nope" })).toThrow(/host:port/);
  });
});

describe("serve", () => {
  it("serves a Hono app and logs one line per request with the request id", async () => {
    const app = new Hono();
    app.get("/hello/:name", (c) => {
      log.info("greeting", { name: c.req.param("name") });
      return c.json({ hello: c.req.param("name") });
    });
    served = await serve(app, { port: 0 });

    const res = await fetch(url("/hello/ada?x=1"), { headers: { "x-request-id": "req-123" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-123");
    expect(await res.json()).toEqual({ hello: "ada" });

    await new Promise((r) => setTimeout(r, 20));
    const greeting = records.find((r) => r.msg === "greeting");
    expect(greeting).toMatchObject({ requestId: "req-123", name: "ada", level: "info" });
    const request = records.find((r) => r.msg === "request");
    expect(request).toMatchObject({ requestId: "req-123", method: "GET", path: "/hello/ada", status: 200 });
    expect(typeof request!.durationMs).toBe("number");
  });

  it("passes request bodies, multiple cookies and streams to fetch apps", async () => {
    const app = new Hono();
    app.post("/echo", async (c) => {
      c.header("set-cookie", "a=1", { append: true });
      c.header("set-cookie", "b=2", { append: true });
      return c.json(await c.req.json());
    });
    app.get("/stream", () => {
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of ["x", "y", "z"]) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    });
    served = await serve(app, { port: 0 });

    const res = await fetch(url("/echo"), { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } });
    expect(await res.json()).toEqual({ a: 1 });
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(await (await fetch(url("/stream"))).text()).toBe("xyz");
  });

  it("turns a thrown error into a 500 and logs it", async () => {
    served = await serve({ fetch: () => Promise.reject(new Error("kaboom")) }, { port: 0 });
    const res = await fetch(url("/"));
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(records.find((r) => r.level === "error")).toMatchObject({ msg: "unhandled error", err: { message: "kaboom" } });
  });

  it("serves an Express app and redacts sensitive fields", async () => {
    const app = express();
    app.use(express.json());
    app.post("/login", (req, res) => {
      log.info("login", { user: req.body.user, password: req.body.password, headers: { authorization: "Bearer x" } });
      res.status(201).json({ ok: true });
    });
    served = await serve(app, { port: 0 });
    const res = await fetch(url("/login"), { method: "POST", body: JSON.stringify({ user: "ada", password: "pw" }), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    expect(records.find((r) => r.msg === "login")).toMatchObject({ user: "ada", password: "[redacted]", headers: { authorization: "[redacted]" } });
    expect(records.find((r) => r.msg === "request")).toMatchObject({ status: 201, method: "POST" });
  });
});

describe("serve edge cases", () => {
  it("keeps a path that starts with // as a path", async () => {
    served = await serve({ fetch: (req: Request) => Response.json({ path: new URL(req.url).pathname, search: new URL(req.url).search }) }, { port: 0 });
    expect(await (await fetch(url("//api/users?x=1"))).json()).toEqual({ path: "//api/users", search: "?x=1" });
  });

  it("cuts the connection instead of appending text when a stream fails midway", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        setTimeout(() => controller.error(new Error("upstream died")), 20);
      },
    });
    served = await serve({ fetch: () => new Response(body) }, { port: 0 });
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  it("closes open streams after the shutdown grace period", async () => {
    const never = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); } });
    served = await serve({ fetch: () => new Response(never) }, { port: 0, shutdownGraceMs: 50 });
    const res = await fetch(url("/"));
    const reader = res.body!.getReader();
    await reader.read();
    const started = Date.now();
    await served.close();
    served = undefined;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("redact", () => {
  it("fails closed on deep nesting and cycles", () => {
    let deep: any = { token: "t" };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).not.toContain('"t"');
    const loop: any = { a: 1 };
    loop.self = loop;
    expect(redact(loop)).toEqual({ a: 1, self: "[circular]" });
  });
});

describe("kv in a deployed function", () => {
  it("refuses to fall back to memory when hatch deployed it without that table", () => {
    process.env.AWS_LAMBDA_HTTP_ENDPOINT = "127.0.0.1:1";
    process.env.HATCH_APP = "x";
    try {
      expect(() => kv("missing")).toThrow(/has no table in this deploy/);
    } finally {
      delete process.env.AWS_LAMBDA_HTTP_ENDPOINT;
      delete process.env.HATCH_APP;
    }
  });
});

describe("LocalKV", () => {
  it("persists to disk and expires keys", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hatch-kv-")), "kv.json");
    const a = new LocalKV<number>(file);
    await a.set("n", 1);
    await a.set("short", 2, { ttl: 0.05 });
    const b = new LocalKV<number>(file);
    expect(await b.get("n")).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(await b.get("short")).toBeUndefined();
    await b.delete("n");
    expect(await new LocalKV(file).get("n")).toBeUndefined();
  });
});

describe("secret", () => {
  it("reads the deployed variable first, then the plain name", () => {
    process.env.HATCH_SECRET_SOME_KEY = "deployed";
    expect(secret("SOME_KEY")).toBe("deployed");
    delete process.env.HATCH_SECRET_SOME_KEY;
    process.env.SOME_KEY = "local";
    expect(secret("SOME_KEY")).toBe("local");
    delete process.env.SOME_KEY;
    expect(() => secret("SOME_KEY")).toThrow(/hatch secrets set SOME_KEY/);
    expect(() => secret("lower")).toThrow(/UPPER_SNAKE_CASE/);
  });
});
