import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";
import { SUPPORTED_REGIONS, type HatchConfig, type StageConfig } from "../runtime/config.js";

export type Framework = "hono" | "express" | "fastify" | "koa" | "next" | "node";

export interface Project {
  root: string;
  name: string;
  entry: string;
  framework: Framework;
  config: HatchConfig;
  pkg: Record<string, any>;
}

export interface Stage {
  name: string;
  regions: string[];
  homeRegion: string;
  canary?: number;
  env: Record<string, string>;
  /** Web function name: `${app}-${stage}`. */
  functionName: string;
}

const CONFIG_FILES = ["hatch.config.ts", "hatch.config.mts", "hatch.config.js", "hatch.config.mjs"];
const ENTRY_CANDIDATES = ["src/index.ts", "src/server.ts", "src/app.ts", "src/main.ts", "index.ts", "server.ts", "src/index.js", "src/server.js", "index.js", "server.js", "app.js"];

export class HatchError extends Error {}

export async function loadConfig(root: string): Promise<HatchConfig> {
  const file = CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (!file) return {};
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const mod = (await jiti.import(file, { default: true })) as HatchConfig | { default: HatchConfig };
  return ("default" in mod ? mod.default : mod) ?? {};
}

export function detectFramework(pkg: Record<string, any>): Framework {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return "next";
  if (deps.hono) return "hono";
  if (deps.express) return "express";
  if (deps.fastify) return "fastify";
  if (deps.koa) return "koa";
  return "node";
}

export function sanitizeName(raw: string): string {
  return raw
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function loadProject(root: string): Promise<Project> {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) throw new HatchError(`No package.json in ${root}. Run hatch from your app's folder.`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const config = await loadConfig(root);

  const name = sanitizeName(config.name ?? pkg.name ?? path.basename(root));
  if (!name) throw new HatchError('Set "name" in hatch.config.ts (lowercase letters, digits, dashes).');

  const entry = config.entry ?? ENTRY_CANDIDATES.find((c) => fs.existsSync(path.join(root, c))) ?? pkg.main;
  if (!entry || !fs.existsSync(path.join(root, entry))) {
    throw new HatchError(`Couldn't find a server entry. Set "entry" in hatch.config.ts (tried ${ENTRY_CANDIDATES.join(", ")}).`);
  }

  const framework = detectFramework(pkg);
  if (framework === "next") {
    throw new HatchError("Next.js needs the hatch Next adapter, which isn't built yet. Hono, Express, Fastify and plain Node servers work today.");
  }
  return { root, name, entry, framework, config, pkg };
}

const STAGE_NAME = /^[a-z0-9][a-z0-9-]{0,19}$/;

export function resolveStage(project: Project, stageName: string, regionOverride?: string[]): Stage {
  if (!STAGE_NAME.test(stageName)) throw new HatchError(`Stage "${stageName}" must be lowercase letters, digits or dashes (max 20).`);
  const stageConfig: StageConfig = project.config.stages?.[stageName] ?? {};
  const regions = regionOverride ?? stageConfig.regions ?? project.config.regions ?? [process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"];
  if (regions.length === 0) throw new HatchError("regions can't be empty.");
  const unsupported = regions.filter((r) => !(SUPPORTED_REGIONS as readonly string[]).includes(r));
  if (unsupported.length) {
    throw new HatchError(`Lambda Web Functions aren't available in ${unsupported.join(", ")}. Supported: ${SUPPORTED_REGIONS.join(", ")}.`);
  }
  if (new Set(regions).size !== regions.length) throw new HatchError("regions contains duplicates.");
  const canary = stageConfig.canary;
  if (canary !== undefined && !(canary >= 1 && canary <= 99)) throw new HatchError("canary must be between 1 and 99.");
  return {
    name: stageName,
    regions,
    homeRegion: regions[0]!,
    canary,
    env: { ...project.config.env, ...stageConfig.env },
    functionName: `${project.name}-${stageName}`,
  };
}

/** Minimal .env parser for `hatch dev`: KEY=value, # comments, optional quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]!] = value;
  }
  return out;
}
