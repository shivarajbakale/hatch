import fs from "node:fs";
import path from "node:path";

const pkgRoot = path.resolve(import.meta.dirname, "..");

/** Fixture apps resolve "hatch" to this package and their framework from our devDependencies. */
export default function setup() {
  for (const [fixture, deps] of Object.entries({ "hono-app": ["hono"], "express-app": ["express"] })) {
    const nm = path.join(pkgRoot, "test", "fixtures", fixture, "node_modules");
    fs.mkdirSync(nm, { recursive: true });
    for (const [name, target] of [["hatch", pkgRoot], ...deps.map((d) => [d, path.join(pkgRoot, "node_modules", d)])]) {
      const link = path.join(nm, name!);
      if (!fs.existsSync(link)) fs.symlinkSync(target!, link, "dir");
    }
  }
}
