import express from "express";
import { log, serve } from "hatch";

const app = express();
app.use(express.json());

app.post("/echo", (req, res) => {
  log.info("echo", { password: "hunter2", size: JSON.stringify(req.body).length });
  res.json({ got: req.body });
});

serve(app);
