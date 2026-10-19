import { defineCommand } from "citty";
import pc from "picocolors";
import { deploy } from "../../deploy.js";
import { context, stageArgs } from "../shared.js";
import { bytes, ui } from "../ui.js";

export default defineCommand({
  meta: { name: "deploy", description: "Build and deploy to Lambda Web Functions" },
  args: {
    ...stageArgs,
    canary: { type: "string", description: "Percent of traffic for the new revision (1-99). 0 turns off a configured canary." },
  },
  async run({ args }) {
    const { project, stage } = await context(args);
    const started = Date.now();
    ui.plain(pc.bold(`Deploying ${project.name} → ${stage.name}`) + pc.dim(` (${stage.regions.join(", ")})`));
    const canary = args.canary !== undefined ? Number(args.canary) : undefined;
    if (canary !== undefined && !(Number.isInteger(canary) && canary >= 0 && canary <= 99)) throw new Error("--canary must be 0-99");

    const result = await deploy(project, stage, { canary, onStep: ui.step });

    const r = result.build.resources;
    ui.ok(`Built ${bytes(result.build.sizeBytes)} · deploy ${result.deployId}` + (r.kv.length || r.secrets.length ? ` · kv: ${r.kv.join(", ") || "none"} · secrets: ${r.secrets.join(", ") || "none"}` : ""));
    for (const w of result.warnings) ui.warn(w);
    ui.ok(`Revision ${result.revisionId} live in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    if (result.weights.length > 1) {
      ui.warn(`Canary at ${result.weights[1]!.weight}%. Check it with "hatch status" and "hatch logs", then "hatch promote" or "hatch rollback".`);
    }
    if (result.url) ui.plain(`\n  ${pc.bold(pc.green(result.url))}\n`);
  },
});
