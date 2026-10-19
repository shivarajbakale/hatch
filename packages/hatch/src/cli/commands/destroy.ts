import { defineCommand } from "citty";
import pc from "picocolors";
import { listKvTables } from "../../aws/dynamo.js";
import { destroy, kvTablePrefix, tags } from "../../deploy.js";
import { context, stageArgs } from "../shared.js";
import { confirm, ui } from "../ui.js";

export default defineCommand({
  meta: { name: "destroy", description: "Delete a stage's web function and role (kv data is kept unless --purge-data)" },
  args: {
    ...stageArgs,
    "purge-data": { type: "boolean", description: "Also delete the stage's kv tables and their data" },
    yes: { type: "boolean", alias: "y", description: "Skip the confirmation prompt" },
  },
  async run({ args }) {
    const { project, stage } = await context(args);
    const purge = Boolean(args["purge-data"]);
    const tables = purge ? await listKvTables(kvTablePrefix(project, stage), stage.homeRegion, tags(project, stage)) : [];
    ui.warn(`This deletes ${pc.bold(stage.functionName)}, its endpoint URL and its IAM role.` + (purge ? ` It also deletes these kv tables and all their data: ${tables.join(", ") || "none"}.` : " kv tables and secrets are kept."));
    if (!args.yes && !(await confirm(`Type ${pc.bold(stage.functionName)} to confirm:`, stage.functionName))) {
      ui.fail("Cancelled.");
      process.exitCode = 1;
      return;
    }
    await destroy(project, stage, { purgeData: purge, onStep: ui.step });
    ui.ok(`Destroyed ${stage.functionName}`);
  },
});
