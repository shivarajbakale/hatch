import express from "express";
import { kv, log, region, serve } from "hatch";

const app = express();
app.use(express.json());
const visits = kv<number>("visits");

app.get("/", async (_req, res) => {
  const count = ((await visits.get("home")) ?? 0) + 1;
  await visits.set("home", count);
  log.info("home visited", { count });
  res.json({ message: "Hello from Hatch", visits: count, region: region.current });
});

app.get("/health", (_req, res) => {
  res.send("ok");
});

serve(app);
