import { createHash } from "node:crypto";
import {
  CreateDistributionWithTagsCommand,
  CreateFunctionCommand,
  CreateInvalidationCommand,
  CreateOriginAccessControlCommand,
  DeleteDistributionCommand,
  DeleteFunctionCommand,
  DeleteOriginAccessControlCommand,
  DescribeFunctionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetFunctionCommand,
  GetOriginAccessControlCommand,
  ListDistributionsCommand,
  ListOriginAccessControlsCommand,
  PublishFunctionCommand,
  UpdateDistributionCommand,
  UpdateFunctionCommand,
  type CacheBehavior,
  type DistributionConfig,
  type DistributionSummary,
} from "@aws-sdk/client-cloudfront";
import { aws, isNotFound, waitFor } from "./clients.js";

/** AWS-managed policies. Their ids are fixed and documented. */
const POLICY = {
  cachingOptimized: "658327ea-f89d-4fab-a63d-7e88639e58f6",
  cachingDisabled: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
  /** Forwards every viewer header, cookie and query string, but not Host: the origin needs its own. */
  allViewerExceptHost: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
};

/** CloudFront waits at most 60s for the origin by default; more needs a quota increase. */
export const MAX_ORIGIN_READ_TIMEOUT = 60;

/** Names for CloudFront functions and OACs: 64 chars of [A-Za-z0-9-_]. */
export function cdnName(functionName: string, suffix: string): string {
  const full = `hatch-${functionName}-${suffix}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha256").update(functionName).digest("hex").slice(0, 8);
  return `${full.slice(0, 63 - suffix.length - 10)}-${hash}-${suffix}`;
}

/** Viewer-request code for the static origin: directory index, plus the SPA fallback. */
export function siteRewriteCode(spa: boolean): string {
  return `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
  } else if (uri.lastIndexOf(".") < uri.lastIndexOf("/")) {
    request.uri = ${spa ? '"/index.html"' : 'uri + "/index.html"'};
  }
  return request;
}`;
}

/** Viewer-request code for server routes: keeps the viewer's host, since the origin sees its own. */
export const FORWARD_HOST_CODE = `function handler(event) {
  var request = event.request;
  request.headers["x-forwarded-host"] = { value: request.headers.host.value };
  return request;
}`;

/** Creates or updates a CloudFront Function and publishes it. Returns the LIVE ARN. */
export async function ensureEdgeFunction(name: string, code: string, comment: string): Promise<string> {
  const cf = aws.cloudfront();
  const body = new TextEncoder().encode(code);
  let live: Uint8Array | undefined;
  try {
    live = (await cf.send(new GetFunctionCommand({ Name: name, Stage: "LIVE" }))).FunctionCode;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const config = { Comment: comment, Runtime: "cloudfront-js-2.0" as const };
  if (live && Buffer.from(live).equals(Buffer.from(body))) {
    const out = await cf.send(new DescribeFunctionCommand({ Name: name, Stage: "LIVE" }));
    return out.FunctionSummary!.FunctionMetadata!.FunctionARN!;
  }
  let etag: string | undefined;
  try {
    etag = (await cf.send(new DescribeFunctionCommand({ Name: name, Stage: "DEVELOPMENT" }))).ETag;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const written = etag
    ? await cf.send(new UpdateFunctionCommand({ Name: name, IfMatch: etag, FunctionConfig: config, FunctionCode: body }))
    : await cf.send(new CreateFunctionCommand({ Name: name, FunctionConfig: config, FunctionCode: body }));
  const published = await cf.send(new PublishFunctionCommand({ Name: name, IfMatch: written.ETag }));
  return published.FunctionSummary?.FunctionMetadata?.FunctionARN ?? written.FunctionSummary!.FunctionMetadata!.FunctionARN!;
}

export async function deleteEdgeFunction(name: string): Promise<boolean> {
  const cf = aws.cloudfront();
  try {
    const { ETag } = await cf.send(new DescribeFunctionCommand({ Name: name }));
    await cf.send(new DeleteFunctionCommand({ Name: name, IfMatch: ETag }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function findOriginAccessControl(name: string): Promise<string | undefined> {
  let marker: string | undefined;
  do {
    const page = await aws.cloudfront().send(new ListOriginAccessControlsCommand({ Marker: marker }));
    const list = page.OriginAccessControlList;
    const hit = list?.Items?.find((o) => o.Name === name);
    if (hit?.Id) return hit.Id;
    marker = list?.IsTruncated ? list.NextMarker : undefined;
  } while (marker);
  return undefined;
}

/** Origin access control: CloudFront signs its requests to S3, so the bucket can stay private. */
export async function ensureOriginAccessControl(name: string): Promise<string> {
  const existing = await findOriginAccessControl(name);
  if (existing) return existing;
  const out = await aws.cloudfront().send(
    new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: { Name: name, Description: "hatch static site", SigningProtocol: "sigv4", SigningBehavior: "always", OriginAccessControlOriginType: "s3" },
    }),
  );
  return out.OriginAccessControl!.Id!;
}

export async function deleteOriginAccessControl(name: string): Promise<boolean> {
  const id = await findOriginAccessControl(name);
  if (!id) return false;
  const { ETag } = await aws.cloudfront().send(new GetOriginAccessControlCommand({ Id: id }));
  await aws.cloudfront().send(new DeleteOriginAccessControlCommand({ Id: id, IfMatch: ETag }));
  return true;
}

export interface FrontDoorSpec {
  functionName: string;
  /** The web function endpoint's domain: the origin for server routes. */
  functionDomain: string;
  readTimeoutSeconds: number;
  forwardHostArn: string;
  /** Path patterns sent to the server when there is a static site. */
  routes: string[];
  site?: { bucketDomain: string; oacId: string; rewriteArn: string };
  domain?: string;
  /** Only set once ACM has issued it: CloudFront rejects aliases without a valid certificate. */
  certificateArn?: string;
}

const FUNCTION_ORIGIN = "function";
const SITE_ORIGIN = "site";
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"] as const;

function functionBehavior(spec: FrontDoorSpec) {
  return {
    TargetOriginId: FUNCTION_ORIGIN,
    ViewerProtocolPolicy: "redirect-to-https" as const,
    AllowedMethods: { Quantity: ALL_METHODS.length, Items: [...ALL_METHODS], CachedMethods: { Quantity: 2, Items: ["GET" as const, "HEAD" as const] } },
    Compress: true,
    CachePolicyId: POLICY.cachingDisabled,
    OriginRequestPolicyId: POLICY.allViewerExceptHost,
    FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request" as const, FunctionARN: spec.forwardHostArn }] },
  };
}

/** The part of the distribution config hatch owns. Anything else set in the console is kept on update. */
export function distributionConfig(spec: FrontDoorSpec, callerReference: string): DistributionConfig {
  const origins: DistributionConfig["Origins"] = {
    Quantity: spec.site ? 2 : 1,
    Items: [
      {
        Id: FUNCTION_ORIGIN,
        DomainName: spec.functionDomain,
        OriginPath: "",
        CustomHeaders: { Quantity: 0 },
        CustomOriginConfig: {
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: "https-only",
          OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
          OriginReadTimeout: spec.readTimeoutSeconds,
          OriginKeepaliveTimeout: 5,
        },
      },
      ...(spec.site
        ? [
            {
              Id: SITE_ORIGIN,
              DomainName: spec.site.bucketDomain,
              OriginPath: "",
              CustomHeaders: { Quantity: 0 },
              S3OriginConfig: { OriginAccessIdentity: "" },
              OriginAccessControlId: spec.site.oacId,
            },
          ]
        : []),
    ],
  };
  const site = spec.site;
  const defaultBehavior = site
    ? {
        TargetOriginId: SITE_ORIGIN,
        ViewerProtocolPolicy: "redirect-to-https" as const,
        AllowedMethods: { Quantity: 2, Items: ["GET" as const, "HEAD" as const], CachedMethods: { Quantity: 2, Items: ["GET" as const, "HEAD" as const] } },
        Compress: true,
        CachePolicyId: POLICY.cachingOptimized,
        FunctionAssociations: { Quantity: 1, Items: [{ EventType: "viewer-request" as const, FunctionARN: site.rewriteArn }] },
      }
    : functionBehavior(spec);
  const behaviors: CacheBehavior[] = site ? spec.routes.map((PathPattern) => ({ PathPattern, ...functionBehavior(spec) })) : [];
  const aliases = spec.domain && spec.certificateArn ? [spec.domain] : [];
  return {
    CallerReference: callerReference,
    Comment: `hatch:${spec.functionName}`,
    Enabled: true,
    Aliases: { Quantity: aliases.length, Items: aliases },
    DefaultRootObject: "",
    Origins: origins,
    DefaultCacheBehavior: defaultBehavior,
    CacheBehaviors: { Quantity: behaviors.length, Items: behaviors },
    PriceClass: "PriceClass_All",
    HttpVersion: "http2and3",
    IsIPV6Enabled: true,
    ViewerCertificate: spec.certificateArn
      ? { ACMCertificateArn: spec.certificateArn, SSLSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021", CloudFrontDefaultCertificate: false }
      : { CloudFrontDefaultCertificate: true },
  };
}

/** Hash of the managed config, kept in the Comment, so an unchanged deploy doesn't redeploy CloudFront. */
export function fingerprint(config: DistributionConfig): string {
  const { CallerReference: _, Comment: __, ...rest } = config;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 12);
}

const commentFor = (functionName: string) => `hatch:${functionName}`;

export async function findDistribution(functionName: string): Promise<DistributionSummary | undefined> {
  const prefix = commentFor(functionName);
  let marker: string | undefined;
  do {
    const page = await aws.cloudfront().send(new ListDistributionsCommand({ Marker: marker }));
    const list = page.DistributionList;
    const hit = list?.Items?.find((d) => d.Comment === prefix || d.Comment?.startsWith(`${prefix} `));
    if (hit) return hit;
    marker = list?.IsTruncated ? list.NextMarker : undefined;
  } while (marker);
  return undefined;
}

export interface FrontDoor {
  id: string;
  arn: string;
  domainName: string;
  created: boolean;
  updated: boolean;
}

export async function ensureDistribution(spec: FrontDoorSpec, tags: Record<string, string>): Promise<FrontDoor> {
  const cf = aws.cloudfront();
  const existing = await findDistribution(spec.functionName);
  if (!existing) {
    const config = distributionConfig(spec, `hatch-${spec.functionName}-${Date.now()}`);
    config.Comment = `${commentFor(spec.functionName)} ${fingerprint(config)}`;
    const out = await cf.send(
      new CreateDistributionWithTagsCommand({
        DistributionConfigWithTags: { DistributionConfig: config, Tags: { Items: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } },
      }),
    );
    const d = out.Distribution!;
    return { id: d.Id!, arn: d.ARN!, domainName: d.DomainName!, created: true, updated: false };
  }

  const current = await cf.send(new GetDistributionConfigCommand({ Id: existing.Id }));
  const desired = distributionConfig(spec, current.DistributionConfig!.CallerReference!);
  const print = fingerprint(desired);
  const base = { id: existing.Id!, arn: existing.ARN!, domainName: existing.DomainName!, created: false };
  if (existing.Comment === `${commentFor(spec.functionName)} ${print}` && existing.Enabled) return { ...base, updated: false };
  await cf.send(
    new UpdateDistributionCommand({
      Id: existing.Id,
      IfMatch: current.ETag,
      DistributionConfig: { ...current.DistributionConfig!, ...desired, Comment: `${commentFor(spec.functionName)} ${print}` },
    }),
  );
  return { ...base, updated: true };
}

export async function invalidateAll(distributionId: string): Promise<void> {
  await aws.cloudfront().send(
    new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: `hatch-${Date.now()}`, Paths: { Quantity: 1, Items: ["/*"] } },
    }),
  );
}

/**
 * CloudFront only deletes a disabled, fully deployed distribution, so this disables it first and
 * waits for that to reach every edge location. That usually takes a few minutes.
 */
export async function deleteDistribution(functionName: string, onWait: () => void = () => {}): Promise<{ domainName: string; aliases: string[] } | undefined> {
  const cf = aws.cloudfront();
  const found = await findDistribution(functionName);
  if (!found) return undefined;
  if (found.Enabled) {
    const current = await cf.send(new GetDistributionConfigCommand({ Id: found.Id }));
    await cf.send(new UpdateDistributionCommand({ Id: found.Id, IfMatch: current.ETag, DistributionConfig: { ...current.DistributionConfig!, Enabled: false } }));
  }
  onWait();
  const etag = await waitFor(
    "the distribution to be disabled",
    async () => {
      const d = await cf.send(new GetDistributionCommand({ Id: found.Id }));
      return d.Distribution?.Status === "Deployed" && !d.Distribution.DistributionConfig?.Enabled ? d.ETag : undefined;
    },
    45 * 60_000,
  );
  await cf.send(new DeleteDistributionCommand({ Id: found.Id, IfMatch: etag }));
  return { domainName: found.DomainName!, aliases: found.Aliases?.Items ?? [] };
}
