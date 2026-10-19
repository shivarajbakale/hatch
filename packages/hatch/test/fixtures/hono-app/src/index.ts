import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { kv, log, region, secret, serve } from "hatch";

const app = new Hono();
const counters = kv<number>("counters");

app.get("/", (c) => c.json({ ok: true, region: region.current }));

app.get("/count", async (c) => {
  const n = ((await counters.get("hits")) ?? 0) + 1;
  await counters.set("hits", n);
  log.info("counted", { n });
  return c.json({ n });
});

app.get("/secret", (c) => c.json({ length: secret("API_KEY").length }));

app.get("/stream", (c) =>
  streamText(c, async (stream) => {
    for (const word of ["a", "b", "c"]) await stream.write(word);
  }),
);

app.get("/boom", () => {
  throw new Error("boom");
});

serve(app);
