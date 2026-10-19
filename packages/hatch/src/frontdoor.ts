import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  FORWARD_HOST_CODE,
  MAX_ORIGIN_READ_TIMEOUT,
  cdnName,
  deleteDistribution,
  deleteEdgeFunction,
  deleteOriginAccessControl,
  ensureDistribution,
  ensureEdgeFunction,
  ensureOriginAccessControl,
  findDistribution,
  invalidateAll,
  siteRewriteCode,
} from "./aws/cdn.js";
import {
  deleteAliasRecords,
  deleteCertificate,
  ensureCertificate,
  findHostedZone,
  findOwnCertificate,
  upsertAliasRecords,
  upsertValidationRecord,
  waitForCertificate,
  type DnsRecord,
} from "./aws/domain.js";
import { allowDistribution, collectSite, deleteSiteBucket, ensureSiteBucket, siteBucketDomain, siteBucketName, syncSite, type SiteFile } from "./aws/site.js";
import { HatchError, type Project, type Stage } from "./build/project.js";

type Step = (message: string) => void;

export const DEFAULT_ROUTES = ["/api/*"];

/** A stage gets a CloudFront front door when it serves static files or has its own domain. */
export function wantsFrontDoor(project: Project, stage: Stage): boolean {
  return Boolean(project.config.static || stage.domain);
}

/** Runs `static.build` if set, then reads `static.dir`. Called before anything touches AWS. */
export function buildStatic(project: Project, step: Step): SiteFile[] | undefined {
  const config = project.config.static;
  if (!config) return undefined;
  if (config.build) {
    step(`Building frontend: ${config.build}`);
    const run = spawnSync(config.build, { cwd: project.root, shell: true, stdio: "inherit" });
    if (run.status !== 0) throw new HatchError(`The frontend build failed (${config.build}).`);
  }
  const dir = path.resolve(project.root, config.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new HatchError(`static.dir "${config.dir}" doesn't exist.${config.build ? "" : " Build your frontend first, or set static.build."}`);
  }
  const files = collectSite(dir);
  if (!files.some((f) => f.key === "index.html")) {
    throw new HatchError(`static.dir "${config.dir}" has no index.html at its root.`);
  }
  return files;
}

export type DomainStatus = "live" | "dns-needed" | "certificate-pending";

export interface FrontDoorResult {
  /** The address to share: the custom domain once it's live, the CloudFront domain until then. */
  url: string;
  cloudfrontUrl: string;
  distributionId: string;
  /** CloudFront takes a few minutes to roll out a new or changed distribution. */
  propagating: boolean;
  site?: { uploaded: number; unchanged: number; stale: number };
  domain?: { name: string; status: DomainStatus; records: DnsRecord[] };
  warnings: string[];
}

export interface FrontDoorInput {
  project: Project;
  stage: Stage;
  account: string;
  functionDomain: string;
  files?: SiteFile[];
  tags: Record<string, string>;
  step: Step;
  /** How long to wait for ACM when hatch wrote the validation record itself. */
  certificateWaitMs?: number;
}

export async function deployFrontDoor(input: FrontDoorInput): Promise<FrontDoorResult> {
  const { project, stage, account, files, tags, step } = input;
  const warnings: string[] = [];
  const fn = stage.functionName;
  const site = project.config.static;

  const timeout = project.config.timeoutSeconds ?? 30;
  if (timeout > MAX_ORIGIN_READ_TIMEOUT) {
    warnings.push(`CloudFront waits at most ${MAX_ORIGIN_READ_TIMEOUT}s for a response, so requests through the front door stop there even though timeoutSeconds is ${timeout}.`);
  }

  step("CloudFront functions");
  const forwardHostArn = await ensureEdgeFunction(cdnName(fn, "fwd"), FORWARD_HOST_CODE, `hatch ${fn}: keep the viewer host`);
  let siteOrigin: { bucketDomain: string; oacId: string; rewriteArn: string } | undefined;
  const bucket = siteBucketName(account, fn);
  if (site) {
    step(`Static site bucket ${bucket}`);
    await ensureSiteBucket(bucket, stage.homeRegion, account, tags);
    siteOrigin = {
      bucketDomain: siteBucketDomain(bucket, stage.homeRegion),
      oacId: await ensureOriginAccessControl(cdnName(fn, "oac")),
      rewriteArn: await ensureEdgeFunction(cdnName(fn, "site"), siteRewriteCode(site.spa ?? true), `hatch ${fn}: index.html rewrites`),
    };
  }

  let certificateArn: string | undefined;
  let domain: FrontDoorResult["domain"];
  const zone = stage.domain ? await findHostedZone(stage.domain) : undefined;
  if (stage.domain) {
    step(`Certificate for ${stage.domain}`);
    const cert = await ensureCertificate(stage.domain, tags);
    let issued = cert.status === "ISSUED";
    if (!issued && cert.validation && zone) {
      step(`Validating ${stage.domain} through Route 53 zone ${zone.name} (usually 1-5 minutes)`);
      await upsertValidationRecord(zone.id, cert.validation);
      issued = await waitForCertificate(cert.arn, input.certificateWaitMs ?? 10 * 60_000);
    }
    if (issued) certificateArn = cert.arn;
    else domain = { name: stage.domain, status: "certificate-pending", records: cert.validation ? [cert.validation] : [] };
  }

  step("CloudFront distribution");
  const dist = await ensureDistribution(
    { functionName: fn, functionDomain: input.functionDomain, readTimeoutSeconds: Math.min(timeout, MAX_ORIGIN_READ_TIMEOUT), forwardHostArn, routes: project.config.routes ?? DEFAULT_ROUTES, site: siteOrigin, domain: stage.domain, certificateArn },
    tags,
  );

  let siteResult: FrontDoorResult["site"];
  if (site && files) {
    await allowDistribution(bucket, stage.homeRegion, dist.arn);
    step(`Uploading ${files.length} static file(s)`);
    const sync = await syncSite(bucket, stage.homeRegion, files);
    siteResult = { uploaded: sync.uploaded.length, unchanged: sync.unchanged, stale: sync.stale.length };
    // A new distribution has no cache to clear.
    if (sync.uploaded.length && !dist.created) await invalidateAll(dist.id);
  }

  if (stage.domain && certificateArn) {
    if (zone) {
      step(`DNS: ${stage.domain} → CloudFront`);
      await upsertAliasRecords(zone.id, stage.domain, dist.domainName);
      domain = { name: stage.domain, status: "live", records: [] };
    } else {
      domain = { name: stage.domain, status: "dns-needed", records: [{ name: stage.domain, type: "CNAME", value: dist.domainName }] };
    }
  }

  const cloudfrontUrl = `https://${dist.domainName}`;
  return {
    url: domain?.status === "live" ? `https://${domain.name}` : cloudfrontUrl,
    cloudfrontUrl,
    distributionId: dist.id,
    propagating: dist.created || dist.updated,
    site: siteResult,
    domain,
    warnings,
  };
}

export async function frontDoorStatus(stage: Stage): Promise<{ url: string; cloudfrontUrl: string; status?: string; aliases: string[] } | undefined> {
  const d = await findDistribution(stage.functionName);
  if (!d) return undefined;
  const aliases = d.Aliases?.Items ?? [];
  const cloudfrontUrl = `https://${d.DomainName}`;
  return { url: aliases[0] ? `https://${aliases[0]}` : cloudfrontUrl, cloudfrontUrl, status: d.Status, aliases };
}

/** Deletes everything deployFrontDoor made. Certificates are deleted only when hatch requested them. */
export async function destroyFrontDoor(stage: Stage, account: string, tags: Record<string, string>, step: Step): Promise<void> {
  const fn = stage.functionName;
  step("Disabling the CloudFront distribution");
  const removed = await deleteDistribution(fn, () => step("Waiting for CloudFront to disable it everywhere (usually 5-15 minutes)"));
  if (!removed) step("No CloudFront distribution found");
  for (const name of [stage.domain, ...(removed?.aliases ?? [])].filter((d, i, all): d is string => Boolean(d) && all.indexOf(d) === i)) {
    const zone = await findHostedZone(name);
    if (zone && removed && (await deleteAliasRecords(zone.id, name, removed.domainName))) step(`Removed DNS records for ${name}`);
    const cert = await findOwnCertificate(name, tags);
    if (cert) {
      step(`Deleting certificate for ${name}`);
      await deleteCertificate(cert);
    }
  }
  await deleteEdgeFunction(cdnName(fn, "fwd"));
  await deleteEdgeFunction(cdnName(fn, "site"));
  await deleteOriginAccessControl(cdnName(fn, "oac"));
  if (await deleteSiteBucket(siteBucketName(account, fn), stage.homeRegion)) step("Deleted the static site bucket");
}
