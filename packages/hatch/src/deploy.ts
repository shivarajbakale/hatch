import path from "node:path";
import type { RevisionConfig, RevisionWeight } from "@aws-sdk/client-lambda-web";
import { ensureArtifactBucket, uploadArtifact } from "./aws/artifacts.js";
import { accountId, sleep } from "./aws/clients.js";
import { deleteKvTable, ensureKvTable, listKvTables } from "./aws/dynamo.js";
import { DEFAULT_TRUST_PRINCIPAL, deleteRole, ensureRole } from "./aws/iam.js";
import { readSecrets } from "./aws/secrets.js";
import {
  RUNTIME,
  createEndpoint,
  createFunction,
  createRevision,
  deleteFunction,
  endpointUrl,
  functionExists,
  getEndpoint,
  listRevisions,
  setWeights,
  waitForEndpoint,
  waitForRevision,
  type Endpoint,
} from "./aws/webfn.js";
import { buildProject, zipBuild, type BuildResult } from "./build/bundle.js";
import { HatchError, type Project, type Stage } from "./build/project.js";
import { kvEnvVar, kvTableName } from "./runtime/kv.js";
import { secretEnvVar } from "./runtime/secret.js";

export type Step = (message: string) => void;

export interface DeployOptions {
  /** Overrides the stage's canary percent. 0 disables it. */
  canary?: number;
  onStep?: Step;
}

export interface DeployResult {
  url?: string;
  revisionId: string;
  deployId: string;
  weights: RevisionWeight[];
  build: BuildResult;
  firstDeploy: boolean;
  warnings: string[];
}

export function tags(project: Project, stage: Stage): Record<string, string> {
  return { "hatch:app": project.name, "hatch:stage": stage.name };
}

export interface Split {
  stable?: string;
  canary?: string;
}

/**
 * Which routed revision is stable and which is the canary. Decided by age, never by weight:
 * a canary at 80% is still the canary, and the older revision is still the one to fall back to.
 */
export function splitTraffic(weights: RevisionWeight[] = [], revisions: { revisionId?: string; createdAt?: Date }[] = []): Split {
  const routed = weights.filter((w) => (w.weight ?? 0) > 0).map((w) => w.revisionId!);
  if (routed.length === 0) return {};
  if (routed.length === 1) return { stable: routed[0] };
  const age = (id: string) => revisions.find((r) => r.revisionId === id)?.createdAt?.getTime() ?? 0;
  const [older, newer] = [...routed].sort((a, b) => age(a) - age(b));
  return { stable: older, canary: newer };
}

/** Weights after deploying `next`. With a canary, the stable revision keeps the rest; an old canary is dropped. */
export function nextWeights(stable: string | undefined, next: string, canary: number | undefined): RevisionWeight[] {
  if (!canary || !stable || stable === next) return [{ revisionId: next, weight: 100 }];
  return [
    { revisionId: stable, weight: 100 - canary },
    { revisionId: next, weight: canary },
  ];
}

const ROLE_NOT_READY = /role|assume|trust|not authorized to perform: sts/i;

/**
 * New IAM roles take a few seconds to become assumable. Retry role-shaped failures for a bounded
 * time on every deploy: the role may have been created by an earlier run that failed right after.
 */
async function withRoleRetry<T>(fn: () => Promise<T>): Promise<T> {
  const attempts = 6;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (i >= attempts || !ROLE_NOT_READY.test(msg)) throw err;
      await sleep(Number(process.env.HATCH_IAM_RETRY_MS ?? 5000));
    }
  }
}

export async function deploy(project: Project, stage: Stage, options: DeployOptions = {}): Promise<DeployResult> {
  const step = options.onStep ?? (() => {});
  const warnings: string[] = [];
  const home = stage.homeRegion;

  step(`Building ${project.entry} (${project.framework})`);
  // One build folder per stage, so deploying two stages from one checkout can't collide.
  const build = await buildProject(project, path.join(project.root, ".hatch", "deploy", stage.name));
  warnings.push(...build.resources.warnings);
  const { zip, sha256 } = zipBuild(build);
  const deployId = sha256.slice(0, 12);

  const account = await accountId(home);

  step("Uploading artifact");
  const bucket = await ensureArtifactBucket(account, home);
  const key = `${project.name}/${stage.name}/${sha256}.zip`;
  await uploadArtifact(home, bucket, key, zip);

  const kvTables = build.resources.kv.map((n) => kvTableName(project.name, stage.name, n));
  for (const [i, name] of build.resources.kv.entries()) {
    step(`kv("${name}") → DynamoDB ${kvTables[i]}${stage.regions.length > 1 ? ` (global: ${stage.regions.join(", ")})` : ""}`);
    await ensureKvTable(kvTables[i]!, home, stage.regions, tags(project, stage));
  }

  const env: Record<string, string> = {
    NODE_OPTIONS: "--enable-source-maps",
    ...stage.env,
    HATCH_APP: project.name,
    HATCH_STAGE: stage.name,
    HATCH_DEPLOY_ID: deployId,
  };
  build.resources.kv.forEach((n, i) => (env[kvEnvVar(n)] = kvTables[i]!));

  if (build.resources.secrets.length) {
    step(`Reading ${build.resources.secrets.length} secret(s) from SSM`);
    const stored = await readSecrets(home, project.name, stage.name);
    const missing = build.resources.secrets.filter((s) => stored[s] === undefined);
    if (missing.length) {
      throw new HatchError(
        `Missing secret(s) for stage "${stage.name}": ${missing.join(", ")}.\n` + missing.map((m) => `  hatch secrets set ${m} <value> --stage ${stage.name}`).join("\n"),
      );
    }
    for (const s of build.resources.secrets) env[secretEnvVar(s)] = stored[s]!;
  }

  step("Execution role");
  const role = await ensureRole({ account, functionName: stage.functionName, kvTables }, project.config.roleTrustPrincipal ?? DEFAULT_TRUST_PRINCIPAL);

  const revisionConfig: RevisionConfig = {
    description: `hatch ${deployId}`,
    buildConfig: { codeConfig: { s3Object: { bucket, key } }, runtimeConfig: { runtime: RUNTIME } },
    serviceConfig: {
      executionRoleArn: role.arn,
      timeoutSeconds: project.config.timeoutSeconds,
      maxConcurrencyPerEnvironment: project.config.maxConcurrency,
      environmentVariables: env,
    },
  };

  const exists = await functionExists(home, stage.functionName);
  let revisionId: string;
  let endpoint: Endpoint | undefined;
  let weights: RevisionWeight[];

  if (!exists) {
    step(`Creating web function ${stage.functionName}`);
    revisionId = await withRoleRetry(() => createFunction(home, stage.functionName, revisionConfig, stage.regions, tags(project, stage)));
    await waitForRevision(home, stage.functionName, revisionId);
    await waitForEndpoint(home, stage.functionName);
    weights = [{ revisionId, weight: 100 }];
    step("Routing 100% of traffic to the first revision");
    endpoint = await setWeights(home, stage.functionName, weights);
  } else {
    step("Creating revision");
    revisionId = await withRoleRetry(() => createRevision(home, stage.functionName, revisionConfig));
    await waitForRevision(home, stage.functionName, revisionId);
    const current = await getEndpoint(home, stage.functionName);
    if (!current) {
      weights = [{ revisionId, weight: 100 }];
      await createEndpoint(home, stage.functionName, stage.regions, weights);
      endpoint = await waitForEndpoint(home, stage.functionName);
    } else {
      const deployed = [...(current.regions ?? [home])].sort().join(",");
      if (stage.regions.length > 1 && deployed !== [...stage.regions].sort().join(",")) {
        warnings.push(`The endpoint serves ${deployed}, but the config says ${stage.regions.join(",")}. Endpoint regions can't change in place; run "hatch destroy --stage ${stage.name}" and deploy again to move regions.`);
      }
      const canary = options.canary ?? stage.canary;
      const { stable } = splitTraffic(current.revisionWeights, canary ? await listRevisions(home, stage.functionName) : []);
      weights = nextWeights(stable, revisionId, canary || undefined);
      step(weights.length > 1 ? `Canary: ${weights[1]!.weight}% to the new revision, ${weights[0]!.weight}% stays on ${weights[0]!.revisionId}` : "Routing 100% of traffic to the new revision");
      endpoint = await setWeights(home, stage.functionName, weights);
    }
  }

  return { url: endpoint ? endpointUrl(endpoint) : undefined, revisionId, deployId, weights, build, firstDeploy: !exists, warnings };
}

export interface StatusResult {
  url?: string;
  regions: string[];
  weights: RevisionWeight[];
  revisions: { revisionId: string; state?: string; createdAt?: Date; description?: string }[];
  endpointState?: string;
  regional: Record<string, { domainName?: string; state?: string }>;
}

export async function status(stage: Stage): Promise<StatusResult | undefined> {
  const home = stage.homeRegion;
  if (!(await functionExists(home, stage.functionName))) return undefined;
  const [ep, revisions] = await Promise.all([getEndpoint(home, stage.functionName), listRevisions(home, stage.functionName)]);
  const regional: StatusResult["regional"] = {};
  for (const [region, r] of Object.entries(ep?.regionalEndpoints ?? {})) regional[region] = { domainName: r.domainName, state: r.state };
  return {
    url: ep ? endpointUrl(ep) : undefined,
    regions: ep?.regions ?? [home],
    weights: ep?.revisionWeights ?? [],
    endpointState: ep?.state,
    revisions: revisions.map((r) => ({ revisionId: r.revisionId!, state: r.state, createdAt: r.createdAt, description: r.description })),
    regional,
  };
}

/** Sends all traffic to the canary revision. */
export async function promote(stage: Stage): Promise<RevisionWeight[]> {
  const ep = await getEndpoint(stage.homeRegion, stage.functionName);
  if (!ep) throw new HatchError(`Nothing deployed to stage "${stage.name}".`);
  const { canary } = splitTraffic(ep.revisionWeights, await listRevisions(stage.homeRegion, stage.functionName));
  if (!canary) throw new HatchError("No canary in progress: one revision already serves all traffic.");
  const next = [{ revisionId: canary, weight: 100 }];
  await setWeights(stage.homeRegion, stage.functionName, next);
  return next;
}

/**
 * During a canary: sends everything back to the stable revision.
 * Otherwise: moves traffic to the newest Active revision older than the current one, or to `to`.
 */
export async function rollback(stage: Stage, to?: string): Promise<{ from?: string; to: string }> {
  const home = stage.homeRegion;
  const ep = await getEndpoint(home, stage.functionName);
  if (!ep) throw new HatchError(`Nothing deployed to stage "${stage.name}".`);
  const revisions = await listRevisions(home, stage.functionName);
  const { stable, canary } = splitTraffic(ep.revisionWeights, revisions);
  let target = to;
  let from = canary ?? stable;
  if (!target && canary) target = stable;
  if (!target) {
    const cutoff = revisions.find((r) => r.revisionId === stable)?.createdAt?.getTime() ?? Infinity;
    target = revisions.find((r) => r.state === "Active" && r.revisionId !== stable && (r.createdAt?.getTime() ?? 0) < cutoff)?.revisionId;
    if (!target) throw new HatchError("No earlier Active revision to roll back to.");
  }
  if (target === from && !canary) from = undefined;
  await setWeights(home, stage.functionName, [{ revisionId: target, weight: 100 }]);
  return { from, to: target };
}

export function kvTablePrefix(project: Project, stage: Stage): string {
  return kvTableName(project.name, stage.name, "");
}

export async function destroy(project: Project, stage: Stage, opts: { purgeData?: boolean; onStep?: Step } = {}): Promise<void> {
  const step = opts.onStep ?? (() => {});
  step(`Deleting web function ${stage.functionName}`);
  const deleted = await deleteFunction(stage.homeRegion, stage.functionName);
  if (!deleted) step("No web function found");
  step("Deleting execution role");
  await deleteRole(stage.functionName);
  if (opts.purgeData) {
    for (const table of await listKvTables(kvTablePrefix(project, stage), stage.homeRegion, tags(project, stage))) {
      step(`Deleting table ${table}`);
      await deleteKvTable(table, stage.homeRegion);
    }
  }
}
