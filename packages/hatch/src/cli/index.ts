#!/usr/bin/env node
import { createRequire } from "node:module";
import { defineCommand, runMain, type CommandDef } from "citty";
import { HatchError } from "../build/project.js";
import deploy from "./commands/deploy.js";
import destroy from "./commands/destroy.js";
import { buildCommand, devCommand, doctorCommand } from "./commands/local.js";
import logs from "./commands/logs.js";
import secrets from "./commands/secrets.js";
import { promoteCommand, rollbackCommand, statusCommand } from "./commands/traffic.js";
import { ui } from "./ui.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const main = defineCommand({
  meta: { name: "hatch", version, description: "Deploy Node web apps to AWS Lambda Web Functions" },
  subCommands: {
    dev: devCommand,
    build: buildCommand,
    deploy,
    status: statusCommand,
    logs,
    promote: promoteCommand,
    rollback: rollbackCommand,
    secrets,
    doctor: doctorCommand,
    destroy,
  },
});

process.on("unhandledRejection", (err) => {
  report(err);
  process.exit(1);
});

/** citty prints raw errors itself, so each command reports its own failures. */
function withErrorReporting(cmd: CommandDef<any>): void {
  const run = cmd.run;
  if (run) {
    cmd.run = async (ctx) => {
      try {
        return await run(ctx);
      } catch (err) {
        report(err);
        process.exit(1);
      }
    };
  }
  for (const sub of Object.values((cmd.subCommands ?? {}) as Record<string, CommandDef<any>>)) withErrorReporting(sub);
}
withErrorReporting(main);

function report(err: unknown) {
  const e = err as Error & { $metadata?: unknown };
  if (e instanceof HatchError) ui.fail(e.message);
  else if (e?.name === "CredentialsProviderError" || /Could not load credentials|profile .* could not be found/i.test(e?.message ?? ""))
    ui.fail(`No usable AWS credentials (${e.message}). Configure them with \`aws configure\`, AWS_PROFILE, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.`);
  else if (e?.$metadata) ui.fail(`AWS ${e.name}: ${e.message}`);
  else ui.fail(e?.stack ?? String(err));
}

runMain(main).catch((err) => {
  report(err);
  process.exit(1);
});
