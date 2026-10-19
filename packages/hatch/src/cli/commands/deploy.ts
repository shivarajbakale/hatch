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
    const door = result.frontDoor;
    if (door?.site) ui.ok(`Static site: ${door.site.uploaded} uploaded, ${door.site.unchanged} unchanged` + (door.site.stale ? pc.dim(` (${door.site.stale} old file(s) kept for open tabs)`) : ""));
    if (door?.domain && door.domain.status !== "live") {
      const { name, status, records } = door.domain;
      ui.warn(
        status === "certificate-pending"
          ? `${name}: add this DNS record so AWS can issue the HTTPS certificate, then run "hatch deploy" again:`
          : `${name}: certificate issued. Point the domain at CloudFront with this DNS record:`,
      );
      for (const r of records) ui.plain(`    ${pc.bold(r.type)}  ${r.name}  →  ${r.value}`);
      if (status === "dns-needed" && name.split(".").length === 2) ui.plain(pc.dim("    Root domains can't be CNAMEs at most DNS providers; use ALIAS/ANAME, or a www subdomain."));
    }
    if (result.url) ui.plain(`\n  ${pc.bold(pc.green(result.url))}\n`);
    if (door?.propagating) ui.plain(pc.dim(`  CloudFront is rolling this out to every edge location; the URL can take a few minutes to answer.\n  The function itself is live now: ${result.functionUrl}\n`));
  },
});
