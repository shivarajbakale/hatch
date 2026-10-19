import { loadProject, resolveStage, type Project, type Stage } from "../build/project.js";

export const stageArgs = {
  stage: { type: "string", alias: "s", description: "Stage to act on (dev, prod, pr-42…)", default: "dev" },
  regions: { type: "string", description: "Comma-separated regions; overrides hatch.config.ts" },
  cwd: { type: "string", description: "App folder", default: "." },
} as const;

export async function context(args: { stage: string; regions?: string; cwd: string }): Promise<{ project: Project; stage: Stage }> {
  const project = await loadProject(args.cwd === "." ? process.cwd() : args.cwd);
  const regions = args.regions?.split(",").map((r) => r.trim()).filter(Boolean);
  const stage = resolveStage(project, args.stage, regions);
  return { project, stage };
}
