import { defineCommand } from "citty";
import pc from "picocolors";
import { deleteSecret, readSecrets, writeSecret } from "../../aws/secrets.js";
import { context, stageArgs } from "../shared.js";
import { ui } from "../ui.js";

const NAME = /^[A-Z][A-Z0-9_]*$/;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const set = defineCommand({
  meta: { name: "set", description: "Store a secret (SSM SecureString). Applies on the next deploy." },
  args: {
    ...stageArgs,
    name: { type: "positional", required: true, description: "UPPER_SNAKE_CASE name" },
    value: { type: "positional", required: false, description: "Value. Omit to read from stdin, which keeps it out of shell history." },
  },
  async run({ args }) {
    if (!NAME.test(args.name)) throw new Error("Secret names must be UPPER_SNAKE_CASE.");
    const { project, stage } = await context(args);
    const value = args.value ?? (await readStdin());
    if (!value) throw new Error("Empty value. Pass it as an argument or pipe it in.");
    await writeSecret(stage.homeRegion, project.name, stage.name, args.name, value);
    ui.ok(`Set ${args.name} for ${stage.name}. Run "hatch deploy --stage ${stage.name}" to apply it.`);
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List secret names (values stay hidden)" },
  args: stageArgs,
  async run({ args }) {
    const { project, stage } = await context(args);
    const secrets = await readSecrets(stage.homeRegion, project.name, stage.name);
    const names = Object.keys(secrets).sort();
    if (!names.length) ui.dim(`No secrets for ${stage.name}.`);
    for (const n of names) ui.plain(`${n}  ${pc.dim("•".repeat(Math.min(12, secrets[n]!.length)))}`);
  },
});

const rm = defineCommand({
  meta: { name: "rm", description: "Delete a secret" },
  args: { ...stageArgs, name: { type: "positional", required: true } },
  async run({ args }) {
    const { project, stage } = await context(args);
    const deleted = await deleteSecret(stage.homeRegion, project.name, stage.name, args.name);
    if (deleted) ui.ok(`Deleted ${args.name} from ${stage.name}`);
    else ui.warn(`${args.name} wasn't set for ${stage.name}`);
  },
});

export default defineCommand({
  meta: { name: "secrets", description: "Manage secrets per stage" },
  subCommands: { set, list, rm },
});
