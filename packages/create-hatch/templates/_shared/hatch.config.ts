import { defineConfig } from "hatch";

export default defineConfig({
  name: "{{name}}",
  // The first region is home. Add more for a multi-region endpoint, e.g. ["us-east-1", "eu-west-1"].
  regions: ["us-east-1"],
  stages: {
    // Each prod deploy sends 10% of traffic to the new revision until you run `hatch promote --stage prod`.
    prod: { canary: 10 },
  },
});
