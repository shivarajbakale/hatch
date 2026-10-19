import { Hono } from "hono";
import { kv, log, region, serve } from "hatch";

const app = new Hono();
const visits = kv<number>("visits");

app.get("/", async (c) => {
  const count = ((await visits.get("home")) ?? 0) + 1;
  await visits.set("home", count);
  log.info("home visited", { count });
  return c.json({ message: "Hello from Hatch", visits: count, region: region.current });
});

app.get("/health", (c) => c.text("ok"));

serve(app);
