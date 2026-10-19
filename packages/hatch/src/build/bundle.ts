import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { zipSync } from "fflate";
import { analyzeFiles, type Resources } from "./analyze.js";
import type { Project } from "./project.js";

export interface BuildResult {
  outDir: string;
  files: string[];
  resources: Resources;
  sizeBytes: number;
}

// ESM bundles of CommonJS packages (Express) still call require() for Node builtins.
const BANNER = [
  "import { createRequire as __hatchCreateRequire } from 'node:module';",
  "import { fileURLToPath as __hatchFileURLToPath } from 'node:url';",
  "import { dirname as __hatchDirname } from 'node:path';",
  "const require = __hatchCreateRequire(import.meta.url);",
  "const __filename = __hatchFileURLToPath(import.meta.url);",
  "const __dirname = __hatchDirname(__filename);",
].join("\n");

export function esbuildOptions(project: Project, outfile: string): esbuild.BuildOptions {
  return {
    absWorkingDir: project.root,
    entryPoints: [project.entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: "linked",
    // Keep identifiers so stack traces stay readable; the sourcemap maps them back anyway.
    minifyWhitespace: true,
    minifySyntax: true,
    metafile: true,
    legalComments: "none",
    banner: { js: BANNER },
    logLevel: "silent",
  };
}

/**
 * Bundles the server into one ESM file plus a launcher. The artifact layout covers both ways a
 * Node runtime is likely to start the app: `node index.js` and `npm start`.
 */
export async function buildProject(project: Project, outDir = path.join(project.root, ".hatch", "build")): Promise<BuildResult> {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const result = await esbuild.build(esbuildOptions(project, path.join(outDir, "server.mjs")));
  const inputs = Object.keys(result.metafile!.inputs);
  const resources = analyzeFiles(project.root, inputs);

  fs.writeFileSync(path.join(outDir, "index.js"), 'import "./server.mjs";\n');
  fs.writeFileSync(
    path.join(outDir, "package.json"),
    JSON.stringify({ name: project.name, private: true, type: "module", main: "index.js", scripts: { start: "node index.js" } }, null, 2),
  );

  const files = fs.readdirSync(outDir).sort();
  const sizeBytes = files.reduce((n, f) => n + fs.statSync(path.join(outDir, f)).size, 0);
  return { outDir, files, resources, sizeBytes };
}

/** Deterministic zip (fixed mtimes) so identical builds hash identically. */
export function zipBuild(build: BuildResult): { zip: Uint8Array; sha256: string } {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  const mtime = new Date("2000-01-01T00:00:00Z");
  for (const f of build.files) entries[f] = [fs.readFileSync(path.join(build.outDir, f)), { mtime }];
  const zip = zipSync(entries, { level: 9 });
  return { zip, sha256: createHash("sha256").update(zip).digest("hex") };
}
