import { defineCommand } from "citty";
import pc from "picocolors";
import { promote, rollback, status } from "../../deploy.js";
import { context, stageArgs } from "../shared.js";
import { table, ui } from "../ui.js";

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Show the endpoint, traffic split and recent revisions" },
  args: { ...stageArgs, json: { type: "boolean", description: "Print JSON" } },
  async run({ args }) {
    const { project, stage } = await context(args);
    const s = await status(stage);
    if (args.json) {
      console.log(JSON.stringify(s ?? null, null, 2));
      return;
    }
    if (!s) {
      ui.warn(`${project.name} isn't deployed to "${stage.name}" yet. Run: hatch deploy --stage ${stage.name}`);
      return;
    }
    ui.plain(`${pc.bold(stage.functionName)}  ${s.url ? pc.green(s.url) : pc.dim("no URL yet")}  ${pc.dim(s.endpointState ?? "")}`);
    ui.plain(pc.dim(`regions: ${s.regions.join(", ")}`));
    const weight = new Map(s.weights.map((w) => [w.revisionId, w.weight]));
    const rows = [["REVISION", "TRAFFIC", "STATE", "CREATED", "DESCRIPTION"].map((h) => pc.dim(h))];
    for (const r of s.revisions.slice(0, 8)) {
      const w = weight.get(r.revisionId);
      rows.push([r.revisionId, w ? pc.bold(`${w}%`) : pc.dim("-"), r.state ?? "", r.createdAt?.toISOString().replace("T", " ").slice(0, 16) ?? "", r.description ?? ""]);
    }
    ui.plain("\n" + table(rows));
    if (Object.keys(s.regional).length > 1) {
      ui.plain("\n" + table([[pc.dim("REGION"), pc.dim("STATE"), pc.dim("REGIONAL URL")], ...Object.entries(s.regional).map(([region, r]) => [region, r.state ?? "", r.domainName ? `https://${r.domainName}` : ""])]));
    }
  },
});

export const promoteCommand = defineCommand({
  meta: { name: "promote", description: "Send 100% of traffic to the canary revision" },
  args: stageArgs,
  async run({ args }) {
    const { stage } = await context(args);
    const weights = await promote(stage);
    ui.ok(`Promoted ${weights[0]!.revisionId} to 100%`);
  },
});

export const rollbackCommand = defineCommand({
  meta: { name: "rollback", description: "End a canary, or move traffic back to the previous revision" },
  args: { ...stageArgs, to: { type: "string", description: "Revision id to roll back to" } },
  async run({ args }) {
    const { stage } = await context(args);
    const result = await rollback(stage, args.to);
    ui.ok(`Traffic moved to ${result.to}${result.from ? pc.dim(` (was ${result.from})`) : ""}`);
  },
});
