import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import * as esbuild from "esbuild";
import pc from "picocolors";
import { analyzeFiles } from "../../build/analyze.js";
import { buildProject, esbuildOptions, zipBuild } from "../../build/bundle.js";
import { doctor } from "../../build/doctor.js";
import { loadProject, parseDotenv } from "../../build/project.js";
import { bytes, ui } from "../ui.js";

const cwdArg = { cwd: { type: "string", description: "App folder", default: "." } } as const;

const resolveRoot = (cwd: string) => (cwd === "." ? process.cwd() : path.resolve(cwd));

export const devCommand = defineCommand({
  meta: { name: "dev", description: "Run the app locally with reload, local kv and .env secrets" },
  args: { ...cwdArg, port: { type: "string", description: "Port", default: "3000" } },
  async run({ args }) {
    const project = await loadProject(resolveRoot(args.cwd));
    const devDir = path.join(project.root, ".hatch", "dev");
    fs.mkdirSync(devDir, { recursive: true });
    const outfile = path.join(devDir, "server.mjs");

    const readDotenv = () => {
      const file = path.join(project.root, ".env");
      return fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
    };

    // Every child we spawned and haven't seen exit. Restarts are serialized through `restarts`,
    // so two quick saves can't leave an orphan holding the port.
    const children = new Set<ChildProcess>();
    const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
    const stopOne = (c: ChildProcess) =>
      new Promise<void>((resolve) => {
        if (exited(c)) return resolve();
        const force = setTimeout(() => c.kill("SIGKILL"), 10_000);
        c.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
        c.kill("SIGTERM");
      });
    const stopAll = () => Promise.all([...children].map(stopOne));

    const start = () => {
      const child = spawn(process.execPath, ["--enable-source-maps", outfile], {
        cwd: project.root,
        stdio: "inherit",
        env: {
          ...process.env,
          ...project.config.env,
          ...readDotenv(),
          HATCH_DEV: "1",
          HATCH_APP: project.name,
          HATCH_STAGE: "local",
          HATCH_DEV_DIR: devDir,
          PORT: args.port,
          HOST: "127.0.0.1",
        },
      });
      children.add(child);
      child.once("exit", () => children.delete(child));
    };

    let restarts = Promise.resolve();

    let first = true;
    const ctx = await esbuild.context({
      ...esbuildOptions(project, outfile),
      plugins: [
        {
          name: "hatch-restart",
          setup(build) {
            build.onEnd(async (result) => {
              if (result.errors.length) {
                ui.fail(`Build failed: ${result.errors[0]!.text}`);
                return;
              }
              const resources = analyzeFiles(project.root, Object.keys(result.metafile?.inputs ?? {}));
              for (const w of resources.warnings) ui.warn(w);
              const dotenv = readDotenv();
              const missing = resources.secrets.filter((s) => dotenv[s] === undefined && process.env[s] === undefined);
              if (missing.length) ui.warn(`Missing in .env: ${missing.join(", ")}`);
              restarts = restarts.then(async () => {
                await stopAll();
                if (first) {
                  ui.ok(`${project.name} (${project.framework}) on ${pc.bold(`http://127.0.0.1:${args.port}`)}`);
                  first = false;
                } else {
                  ui.dim("Rebuilt, restarting…");
                }
                start();
              });
              await restarts;
            });
          },
        },
      ],
    });
    await ctx.watch();
    const shutdown = async () => {
      await ctx.dispose();
      await restarts;
      await stopAll();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await new Promise(() => {});
  },
});

export const buildCommand = defineCommand({
  meta: { name: "build", description: "Bundle the app into .hatch/build without deploying" },
  args: cwdArg,
  async run({ args }) {
    const project = await loadProject(resolveRoot(args.cwd));
    const build = await buildProject(project);
    const { zip, sha256 } = zipBuild(build);
    for (const w of build.resources.warnings) ui.warn(w);
    ui.ok(`${path.relative(process.cwd(), build.outDir) || build.outDir}: ${build.files.join(", ")} (${bytes(build.sizeBytes)}, zip ${bytes(zip.length)}, ${sha256.slice(0, 12)})`);
    ui.plain(`  kv: ${build.resources.kv.join(", ") || pc.dim("none")}\n  secrets: ${build.resources.secrets.join(", ") || pc.dim("none")}`);
    ui.dim(`  Run locally: AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node ${path.join(path.relative(process.cwd(), build.outDir), "index.js")}`);
  },
});

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Find code that breaks when the server runs on Lambda Web Functions" },
  args: cwdArg,
  async run({ args }) {
    const root = resolveRoot(args.cwd);
    const findings = doctor(root);
    if (!findings.length) {
      ui.ok("No problems found.");
      return;
    }
    const icon = { error: pc.red("✗"), warn: pc.yellow("!"), info: pc.blue("i") };
    for (const f of findings) {
      ui.plain(`${icon[f.severity]} ${pc.bold(`${f.file}:${f.line}`)} ${f.message}`);
      ui.plain(`  ${pc.dim(f.fix)}`);
    }
    const errors = findings.filter((f) => f.severity === "error").length;
    ui.plain(`\n${findings.length} finding(s), ${errors} error(s)`);
    if (errors) process.exitCode = 1;
  },
});
