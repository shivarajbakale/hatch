#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const TEMPLATES = ["hono", "express"] as const;
export type Template = (typeof TEMPLATES)[number];

const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

// npm drops dotfiles like .gitignore from published packages, so templates store them without the dot.
const RENAME: Record<string, string> = { gitignore: ".gitignore", "env.example": ".env.example" };

function copyDir(from: string, to: string, vars: Record<string, string>) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, RENAME[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest, vars);
      continue;
    }
    let text = fs.readFileSync(src, "utf8");
    // Only our own placeholders; GitHub's ${{ }} expressions pass through untouched.
    for (const [key, value] of Object.entries(vars)) text = text.replaceAll(`{{${key}}}`, value);
    fs.writeFileSync(dest, text);
  }
}

export function appName(dir: string): string {
  return (
    path
      .basename(path.resolve(dir))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "hatch-app"
  );
}

export function scaffold(dir: string, template: Template, hatchVersion = "^0.1.0"): string {
  const target = path.resolve(dir);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`${dir} already exists and isn't empty.`);
  }
  const vars = { name: appName(dir), hatchVersion };
  copyDir(path.join(templatesDir, template), target, vars);
  copyDir(path.join(templatesDir, "_shared"), target, vars);
  return target;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      template: { type: "string", short: "t", default: "hono" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: npm create hatch@latest [dir] -- --template ${TEMPLATES.join("|")}`);
    return;
  }
  const template = values.template as Template;
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}". Choose: ${TEMPLATES.join(", ")}`);
  const dir = positionals[0] ?? "my-hatch-app";
  const target = scaffold(dir, template);
  const rel = path.relative(process.cwd(), target) || ".";
  console.log(`\n✓ Created ${appName(dir)} (${template}) in ${rel}\n`);
  console.log(`  cd ${rel}`);
  console.log("  npm install");
  console.log("  npx hatch dev        # http://127.0.0.1:3000");
  console.log("  npx hatch deploy     # needs AWS credentials\n");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}
