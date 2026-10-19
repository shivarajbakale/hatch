import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appName, scaffold } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "create-hatch-"));

for (const template of ["hono", "express"]) {
  test(`scaffolds the ${template} template`, () => {
    const dir = path.join(tmp(), "My Cool_App");
    scaffold(dir, template);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, [".env.example", ".github", ".gitignore", "hatch.config.ts", "package.json", "src", "tsconfig.json"]);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.name, "my-cool-app");
    assert.ok(pkg.dependencies[template]);
    assert.match(fs.readFileSync(path.join(dir, "hatch.config.ts"), "utf8"), /name: "my-cool-app"/);
    const workflow = fs.readFileSync(path.join(dir, ".github/workflows/hatch.yml"), "utf8");
    assert.match(workflow, /\$\{\{ github\.event\.pull_request\.number \}\}/, "GitHub expressions survive templating");
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "src/index.ts"), "utf8"), /\{\{/);
  });
}

test("refuses a non-empty folder", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "x"), "");
  assert.throws(() => scaffold(dir, "hono"), /isn't empty/);
});

test("app names are safe", () => {
  assert.equal(appName("/a/b/--Weird  Name!!"), "weird-name");
  assert.equal(appName("/"), "hatch-app");
});
