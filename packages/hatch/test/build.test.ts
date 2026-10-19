import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildProject, zipBuild } from "../src/build/bundle.js";
import { loadProject } from "../src/build/project.js";

const fixture = (name: string) => path.resolve(import.meta.dirname, "fixtures", name);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Starts the built artifact exactly the way Lambda would: `node index.js` with AWS_LAMBDA_HTTP_ENDPOINT. */
async function runArtifact(outDir: string, env: Record<string, string> = {}) {
  const port = await freePort();
  const lines: string[] = [];
  const child = spawn(process.execPath, ["index.js"], {
    cwd: outDir,
    env: { PATH: process.env.PATH, AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}`, AWS_REGION: "eu-west-1", HATCH_STAGE: "test", ...env },
  });
  child.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  child.stderr.on("data", (d) => lines.push(String(d)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${lines.join("\n")}`)), 10_000);
    child.stdout.on("data", () => {
      if (lines.some((l) => l.includes('"listening"'))) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${lines.join("\n")}`)));
  });
  return {
    url: (p: string) => `http://127.0.0.1:${port}${p}`,
    lines,
    json: () => lines.flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    }),
    stop: () => new Promise<number | null>((resolve) => {
      child.removeAllListeners("exit");
      child.once("exit", (code) => resolve(code));
      child.kill("SIGTERM");
    }),
  };
}

describe("hono fixture", () => {
  it("detects the project and its resources", async () => {
    const project = await loadProject(fixture("hono-app"));
    expect(project).toMatchObject({ name: "hono-fixture", entry: "src/index.ts", framework: "hono" });
    const build = await buildProject(project);
    expect(build.resources).toEqual({ kv: ["counters"], secrets: ["API_KEY"], warnings: [] });
    expect(build.files).toEqual(["index.js", "package.json", "server.mjs", "server.mjs.map"]);

    const { zip, sha256 } = zipBuild(build);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(build.files);
    expect(zipBuild(build).sha256).toBe(sha256); // deterministic
  });

  it("runs as a Lambda artifact: binds the endpoint, logs JSON, streams, survives errors, shuts down on SIGTERM", async () => {
    const project = await loadProject(fixture("hono-app"));
    const build = await buildProject(project);
    const app = await runArtifact(build.outDir, { HATCH_SECRET_API_KEY: "sk_test_123", HATCH_DEPLOY_ID: "abc123" });
    try {
      expect(await (await fetch(app.url("/"))).json()).toEqual({ ok: true, region: "eu-west-1" });
      expect(await (await fetch(app.url("/count"))).json()).toEqual({ n: 1 });
      expect(await (await fetch(app.url("/count"))).json()).toEqual({ n: 2 }); // memory fallback outside AWS
      expect(await (await fetch(app.url("/secret"))).json()).toEqual({ length: 11 });
      expect(await (await fetch(app.url("/stream"))).text()).toBe("abc");
      expect((await fetch(app.url("/boom"))).status).toBe(500);
      await new Promise((r) => setTimeout(r, 50));

      const records = app.json();
      const requests = records.filter((r) => r.msg === "request");
      expect(requests.map((r) => `${r.status} ${r.path}`)).toEqual(["200 /", "200 /count", "200 /count", "200 /secret", "200 /stream", "500 /boom"]);
      expect(requests[0]).toMatchObject({ coldStart: true, region: "eu-west-1", stage: "test", deploy: "abc123" });
      expect(requests[1].coldStart).toBe(false);
      const counted = records.find((r) => r.msg === "counted");
      expect(counted.requestId).toBe(requests[1].requestId);
    } finally {
      expect(await app.stop()).toBe(0);
    }
  });
});

describe("express fixture", () => {
  it("bundles CommonJS Express into ESM and serves it", async () => {
    const project = await loadProject(fixture("express-app"));
    expect(project.framework).toBe("express");
    const build = await buildProject(project);
    const app = await runArtifact(build.outDir);
    try {
      const res = await fetch(app.url("/echo"), { method: "POST", body: JSON.stringify({ hi: 1 }), headers: { "content-type": "application/json" } });
      expect(await res.json()).toEqual({ got: { hi: 1 } });
      await new Promise((r) => setTimeout(r, 50));
      expect(app.json().find((r) => r.msg === "echo")).toMatchObject({ password: "[redacted]", size: 8 });
    } finally {
      await app.stop();
    }
  });
});
