import { defineCommand } from "citty";
import pc from "picocolors";
import { accountId } from "../../aws/clients.js";
import { queryLogs, tailLogs, type LogFilter } from "../../aws/logs.js";
import { context, stageArgs } from "../shared.js";
import { formatEvent, parseDuration, ui } from "../ui.js";

export default defineCommand({
  meta: { name: "logs", description: "Logs from every region, merged. Live by default; --since for history." },
  args: {
    ...stageArgs,
    since: { type: "string", description: "Show past logs instead of tailing, e.g. 30m, 2h, 1d" },
    status: { type: "string", description: "Only requests with this status: 5xx, 4xx, 404…" },
    request: { type: "string", description: "Only lines for one request id" },
    path: { type: "string", description: "Only requests for this exact path" },
    level: { type: "string", description: "Only this level: error, warn, info" },
    deploy: { type: "string", description: "Only lines from this deploy id" },
    limit: { type: "string", description: "Max lines with --since", default: "500" },
  },
  async run({ args }) {
    const { stage } = await context(args);
    const filter: LogFilter = { status: args.status, requestId: args.request, path: args.path, level: args.level, deploy: args.deploy };
    const multi = stage.regions.length > 1;

    if (args.since) {
      const events = await queryLogs(stage.regions, stage.functionName, Date.now() - parseDuration(args.since), filter, Number(args.limit));
      if (!events.length) ui.dim("No matching logs.");
      for (const e of events) console.log(formatEvent(e, multi));
      return;
    }

    const account = await accountId(stage.homeRegion);
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    ui.dim(`Tailing ${stage.functionName} in ${stage.regions.join(", ")}. Ctrl-C to stop.`);
    let missing = 0;
    await tailLogs(stage.regions, account, stage.functionName, filter, (e) => console.log(formatEvent(e, multi)), controller.signal, (region) => {
      missing++;
      ui.warn(`No logs in ${region} yet. The log group appears after the first request reaches ${stage.functionName} there.`);
    });
    if (missing === stage.regions.length) return;
    if (!controller.signal.aborted) ui.dim(pc.dim("Live tail session ended (3 hour limit). Run again to continue."));
  },
});
