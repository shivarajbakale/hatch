import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/build/analyze.js";
import { checkDependencies, checkSource } from "../src/build/doctor.js";
import { filterPattern } from "../src/aws/logs.js";
import { roleName } from "../src/aws/iam.js";
import { nextWeights, splitTraffic } from "../src/deploy.js";

describe("analyzeSource", () => {
  it("finds kv and secret names, including aliases and namespace imports", () => {
    const src = `
      import { kv as store, secret } from "hatch";
      import * as h from "hatch";
      const a = store("cache");
      const b = h.kv(\`sessions\`);
      const key = secret("STRIPE_KEY");
      function later() { return h.secret("OPENAI_KEY"); }
    `;
    expect(analyzeSource("a.ts", src)).toEqual({ kv: ["cache", "sessions"], secrets: ["OPENAI_KEY", "STRIPE_KEY"], warnings: [] });
  });

  it("ignores same-named functions not imported from hatch", () => {
    expect(analyzeSource("a.ts", `import { kv } from "./mine"; kv("x");`).kv).toEqual([]);
  });

  it("warns on dynamic names", () => {
    const result = analyzeSource("src/a.ts", `import { kv } from "hatch";\nconst n = "x";\nkv(n);`);
    expect(result.kv).toEqual([]);
    expect(result.warnings[0]).toMatch(/^src\/a\.ts:3 kv\(\) needs a string literal/);
  });
});

describe("doctor", () => {
  it("flags patterns that break on serverless", () => {
    const src = [
      'import { Server } from "socket.io";',
      "const sessions = new Map();",
      "setInterval(() => {}, 1000);",
      'fs.writeFileSync("./uploads/a.png", buf);',
      "app.listen(3000);",
    ].join("\n");
    const rules = checkSource("server.ts", src).map((f) => `${f.rule}:${f.line}`);
    expect(rules).toEqual(expect.arrayContaining(["websockets:1", "memory-state:2", "timers:3", "local-disk:4", "listen:5"]));
    expect(checkSource("server.ts", src).find((f) => f.rule === "listen")?.severity).toBe("error");
  });

  it("notes native modules", () => {
    expect(checkDependencies({ dependencies: { sharp: "1", hono: "4" } }).map((f) => f.message)).toEqual(["sharp has native code"]);
  });
});

describe("log filters", () => {
  it("builds CloudWatch JSON patterns", () => {
    expect(filterPattern({ status: "5xx" })).toBe("{ $.status >= 500 && $.status < 600 }");
    expect(filterPattern({ status: "404", requestId: 'r"1' })).toBe('{ ($.status = 404) && ($.requestId = "r1") }');
    expect(filterPattern({})).toBeUndefined();
    expect(() => filterPattern({ status: "bad" })).toThrow();
  });
});

describe("traffic weights", () => {
  const revs = [
    { revisionId: "r1", createdAt: new Date("2026-10-01") },
    { revisionId: "r2", createdAt: new Date("2026-10-02") },
  ];

  it("sends everything to a new revision without a canary", () => {
    expect(nextWeights("r1", "r2", undefined)).toEqual([{ revisionId: "r2", weight: 100 }]);
  });
  it("splits off a canary from the stable revision", () => {
    expect(nextWeights("r1", "r2", 10)).toEqual([
      { revisionId: "r1", weight: 90 },
      { revisionId: "r2", weight: 10 },
    ]);
  });
  it("tells stable from canary by age, even when the canary has most of the traffic", () => {
    const weights = [
      { revisionId: "r2", weight: 80 },
      { revisionId: "r1", weight: 20 },
    ];
    expect(splitTraffic(weights, revs)).toEqual({ stable: "r1", canary: "r2" });
    expect(splitTraffic([{ revisionId: "r2", weight: 100 }], revs)).toEqual({ stable: "r2" });
    expect(splitTraffic([], revs)).toEqual({});
  });
});

describe("roleName", () => {
  it("stays readable when short and unique when truncated", () => {
    expect(roleName("app-prod")).toBe("hatch-app-prod");
    const long = "a".repeat(40);
    const a = roleName(`${long}-pr-42`);
    const b = roleName(`${long}-pr-421`);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });
});
