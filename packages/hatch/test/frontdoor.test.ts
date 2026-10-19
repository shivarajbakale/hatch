import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DescribeCertificateCommand, ACMClient, DeleteCertificateCommand, ListCertificatesCommand, ListTagsForCertificateCommand, RequestCertificateCommand } from "@aws-sdk/client-acm";
import {
  CloudFrontClient,
  CreateDistributionWithTagsCommand,
  CreateFunctionCommand,
  CreateInvalidationCommand,
  CreateOriginAccessControlCommand,
  DeleteDistributionCommand,
  DeleteFunctionCommand,
  DescribeFunctionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetFunctionCommand,
  ListDistributionsCommand,
  ListOriginAccessControlsCommand,
  PublishFunctionCommand,
  UpdateDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import { DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetRoleCommand, IAMClient, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  CreateWebFunctionRevisionCommand,
  GetWebFunctionCommand,
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  LambdaWebClient,
  ListWebFunctionEndpointsCommand,
  UpdateWebFunctionEndpointCommand,
} from "@aws-sdk/client-lambda-web";
import { ChangeResourceRecordSetsCommand, ListHostedZonesCommand, ListResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cdnName, distributionConfig, siteRewriteCode } from "../src/aws/cdn.js";
import { resetClients } from "../src/aws/clients.js";
import { cacheControl, contentType, siteBucketName } from "../src/aws/site.js";
import { loadProject, resolveStage, type Project } from "../src/build/project.js";
import { deploy, destroy } from "../src/deploy.js";
import { serve, type Served } from "../src/runtime/index.js";

const lw = mockClient(LambdaWebClient);
const s3 = mockClient(S3Client);
const ddb = mockClient(DynamoDBClient);
const iam = mockClient(IAMClient);
const ssm = mockClient(SSMClient);
const sts = mockClient(STSClient);
const cf = mockClient(CloudFrontClient);
const acm = mockClient(ACMClient);
const r53 = mockClient(Route53Client);

const notFound = (name = "ResourceNotFoundException") => Object.assign(new Error(name), { name });
const fixture = path.resolve(import.meta.dirname, "fixtures", "hono-app");
const FN_DOMAIN = "abc.def.lambda-web.us-east-1.on.aws";
const CF_DOMAIN = "d111abc.cloudfront.net";
const CERT = "arn:aws:acm:us-east-1:123456789012:certificate/c-1";
const DIST_ARN = "arn:aws:cloudfront::123456789012:distribution/E1";

let base: Project;
let siteDir: string;

beforeAll(async () => {
  process.env.HATCH_POLL_MS = "1";
  process.env.HATCH_IAM_RETRY_MS = "1";
  base = await loadProject(fixture);
  siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "hatch-site-"));
  fs.writeFileSync(path.join(siteDir, "index.html"), "<!doctype html><div id=app></div>");
  fs.mkdirSync(path.join(siteDir, "assets"));
  fs.writeFileSync(path.join(siteDir, "assets", "index-B3x9Kq7a.js"), "console.log(1)");
});

afterAll(() => {
  delete process.env.HATCH_POLL_MS;
  delete process.env.HATCH_IAM_RETRY_MS;
});

const withConfig = (config: Project["config"]): Project => ({ ...base, config: { ...base.config, ...config } });
const fullStack = (domain?: string) => withConfig({ static: { dir: siteDir }, ...(domain ? { stages: { prod: { domain } } } : {}) });

beforeEach(() => {
  for (const m of [lw, s3, ddb, iam, ssm, sts, cf, acm, r53]) m.reset();
  resetClients();
  sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012" });
  s3.on(HeadBucketCommand).resolves({});
  s3.on(HeadObjectCommand).rejects(notFound("NotFound"));
  s3.on(PutObjectCommand).resolves({});
  s3.on(ListObjectsV2Command).resolves({ Contents: [] });
  s3.on(PutBucketPolicyCommand).resolves({});
  ddb.on(DescribeTableCommand).resolves({ Table: { TableStatus: "ACTIVE", Replicas: [] } });
  ddb.on(DescribeTimeToLiveCommand).resolves({ TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" } });
  ssm.on(GetParametersByPathCommand).resolves({ Parameters: [{ Name: "/hatch/hono-fixture/prod/API_KEY", Value: "sk" }] });
  iam.on(GetRoleCommand).resolves({ Role: { Arn: "arn:aws:iam::123456789012:role/r" } as any });
  iam.on(UpdateAssumeRolePolicyCommand).resolves({});
  iam.on(PutRolePolicyCommand).resolves({});
  lw.on(GetWebFunctionCommand).resolves({});
  lw.on(CreateWebFunctionRevisionCommand).resolves({ revisionId: "rev-2" });
  lw.on(GetWebFunctionRevisionCommand).resolves({ state: "Active" });
  lw.on(UpdateWebFunctionEndpointCommand).resolves({});
  lw.on(GetWebFunctionEndpointCommand).resolves({ state: "Active", updateStatus: "Successful", domainName: FN_DOMAIN, regions: ["us-east-1"], revisionWeights: [{ revisionId: "rev-1", weight: 100 }] });

  // A fresh account: no CloudFront resources yet.
  cf.on(GetFunctionCommand).rejects(notFound("NoSuchFunctionExists"));
  cf.on(DescribeFunctionCommand).rejects(notFound("NoSuchFunctionExists"));
  cf.on(CreateFunctionCommand).callsFake((input) => ({ ETag: "E-dev", FunctionSummary: { FunctionMetadata: { FunctionARN: `arn:fn/${input.Name}` } } }));
  cf.on(PublishFunctionCommand).callsFake((input) => ({ FunctionSummary: { FunctionMetadata: { FunctionARN: `arn:fn/${input.Name}` } } }));
  cf.on(ListOriginAccessControlsCommand).resolves({ OriginAccessControlList: { Items: [] } as any });
  cf.on(CreateOriginAccessControlCommand).resolves({ OriginAccessControl: { Id: "OAC1" } as any });
  cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [] } as any });
  cf.on(CreateDistributionWithTagsCommand).resolves({ Distribution: { Id: "E1", ARN: DIST_ARN, DomainName: CF_DOMAIN } as any });
  cf.on(CreateInvalidationCommand).resolves({});

  acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [] });
  acm.on(RequestCertificateCommand).resolves({ CertificateArn: CERT });
  r53.on(ListHostedZonesCommand).resolves({ HostedZones: [] });
  r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [] });
  r53.on(ChangeResourceRecordSetsCommand).resolves({});
});

const created = () => cf.commandCalls(CreateDistributionWithTagsCommand)[0]!.args[0].input.DistributionConfigWithTags!.DistributionConfig!;

describe("front door helpers", () => {
  it("caches hashed bundle files for a year and revalidates everything else", () => {
    expect(cacheControl("assets/index-B3x9Kq7a.js")).toMatch(/immutable/);
    expect(cacheControl("app.3f9a1c2b.css")).toMatch(/immutable/);
    expect(cacheControl("index.html")).toMatch(/max-age=0/);
    expect(cacheControl("my-component.css")).toMatch(/max-age=0/);
    expect(cacheControl("favicon-32x32.png")).toMatch(/max-age=0/);
    expect(contentType("a/b.woff2")).toBe("font/woff2");
    expect(contentType("x.unknown")).toBe("application/octet-stream");
  });

  it("keeps generated names within AWS limits and unique", () => {
    const long = "a".repeat(55);
    expect(cdnName(`${long}-pr-1`, "site").length).toBeLessThanOrEqual(64);
    expect(cdnName(`${long}-pr-1`, "site")).not.toBe(cdnName(`${long}-pr-2`, "site"));
    expect(siteBucketName("123456789012", `${long}-x`).length).toBeLessThanOrEqual(63);
  });

  it("rewrites paths to index.html for SPAs and directories", () => {
    const run = (spa: boolean, uri: string) => new Function(`${siteRewriteCode(spa)}; return handler({ request: { uri: ${JSON.stringify(uri)} } }).uri;`)();
    expect(run(true, "/settings/profile")).toBe("/index.html");
    expect(run(true, "/assets/app.js")).toBe("/assets/app.js");
    expect(run(true, "/")).toBe("/index.html");
    expect(run(false, "/about")).toBe("/about/index.html");
    expect(run(false, "/docs/")).toBe("/docs/index.html");
  });

  it("routes everything to the server when there is no static site", () => {
    const config = distributionConfig({ functionName: "f", functionDomain: FN_DOMAIN, readTimeoutSeconds: 30, forwardHostArn: "fwd", routes: ["/api/*"] }, "ref");
    expect(config.Origins!.Items!.map((o) => o.Id)).toEqual(["function"]);
    expect(config.DefaultCacheBehavior!.TargetOriginId).toBe("function");
    expect(config.CacheBehaviors!.Quantity).toBe(0);
  });
});

describe("deploy with a front door", () => {
  it("serves the site from S3 and /api/* from the function, on a Route 53 domain", async () => {
    r53.on(ListHostedZonesCommand).resolves({ HostedZones: [{ Id: "/hostedzone/Z1", Name: "example.com.", CallerReference: "x", Config: { PrivateZone: false } }] });
    acm.on(DescribeCertificateCommand)
      .resolvesOnce({ Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{ DomainName: "app.example.com", ResourceRecord: { Name: "_x.app.example.com.", Type: "CNAME", Value: "_y.acm-validations.aws." } }] } })
      .resolves({ Certificate: { Status: "ISSUED" } });

    const project = fullStack("app.example.com");
    const result = await deploy(project, resolveStage(project, "prod"));

    expect(result.url).toBe("https://app.example.com");
    expect(result.functionUrl).toBe(`https://${FN_DOMAIN}`);
    expect(result.frontDoor).toMatchObject({ cloudfrontUrl: `https://${CF_DOMAIN}`, propagating: true, domain: { status: "live" }, site: { uploaded: 2, unchanged: 0 } });
    expect(lw.commandCalls(CreateWebFunctionRevisionCommand)[0]!.args[0].input.serviceConfig!.environmentVariables!.HATCH_FRONT_DOOR).toBe("1");

    const config = created();
    expect(config.Aliases).toEqual({ Quantity: 1, Items: ["app.example.com"] });
    expect(config.ViewerCertificate).toMatchObject({ ACMCertificateArn: CERT, SSLSupportMethod: "sni-only" });
    expect(config.Origins!.Items!.find((o) => o.Id === "function")!.DomainName).toBe(FN_DOMAIN);
    expect(config.Origins!.Items!.find((o) => o.Id === "site")).toMatchObject({ DomainName: "hatch-site-123456789012-hono-fixture-prod.s3.us-east-1.amazonaws.com", OriginAccessControlId: "OAC1" });
    expect(config.DefaultCacheBehavior).toMatchObject({ TargetOriginId: "site", FunctionAssociations: { Items: [{ FunctionARN: "arn:fn/hatch-hono-fixture-prod-site" }] } });
    expect(config.CacheBehaviors!.Items![0]).toMatchObject({ PathPattern: "/api/*", TargetOriginId: "function", FunctionAssociations: { Items: [{ FunctionARN: "arn:fn/hatch-hono-fixture-prod-fwd" }] } });

    // The bucket is readable by this distribution only.
    const policy = JSON.parse(s3.commandCalls(PutBucketPolicyCommand)[0]!.args[0].input.Policy!);
    expect(policy.Statement[0].Condition).toEqual({ StringEquals: { "AWS:SourceArn": DIST_ARN } });

    const puts = s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input).filter((i) => !String(i.Key).endsWith(".zip"));
    expect(puts.map((p) => [p.Key, p.ContentType])).toEqual(
      expect.arrayContaining([
        ["index.html", "text/html; charset=utf-8"],
        ["assets/index-B3x9Kq7a.js", "text/javascript; charset=utf-8"],
      ]),
    );

    const changes = r53.commandCalls(ChangeResourceRecordSetsCommand).map((c) => c.args[0].input.ChangeBatch!.Changes!);
    expect(changes[0]![0]!.ResourceRecordSet).toMatchObject({ Name: "_x.app.example.com", Type: "CNAME" });
    expect(changes[1]!.map((c) => [c.ResourceRecordSet!.Type, c.ResourceRecordSet!.AliasTarget!.DNSName])).toEqual([
      ["A", CF_DOMAIN],
      ["AAAA", CF_DOMAIN],
    ]);
    // New distributions have nothing cached.
    expect(cf.commandCalls(CreateInvalidationCommand)).toHaveLength(0);
  });

  it("prints the validation record when the domain isn't in Route 53, and serves on CloudFront meanwhile", async () => {
    acm.on(DescribeCertificateCommand).resolves({
      Certificate: { Status: "PENDING_VALIDATION", DomainValidationOptions: [{ DomainName: "app.other.dev", ResourceRecord: { Name: "_v.app.other.dev.", Type: "CNAME", Value: "_w.acm-validations.aws." } }] },
    });
    const project = fullStack("app.other.dev");
    const result = await deploy(project, resolveStage(project, "prod"));
    expect(result.url).toBe(`https://${CF_DOMAIN}`);
    expect(result.frontDoor!.domain).toEqual({ name: "app.other.dev", status: "certificate-pending", records: [{ name: "_v.app.other.dev", type: "CNAME", value: "_w.acm-validations.aws" }] });
    expect(created().Aliases).toEqual({ Quantity: 0, Items: [] });
    expect(created().ViewerCertificate).toEqual({ CloudFrontDefaultCertificate: true });
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
  });

  it("asks for a CNAME once the certificate is issued but DNS is elsewhere", async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ DomainName: "app.other.dev", CertificateArn: CERT, Status: "ISSUED" }] });
    acm.on(DescribeCertificateCommand).resolves({ Certificate: { Status: "ISSUED" } });
    const project = fullStack("app.other.dev");
    const result = await deploy(project, resolveStage(project, "prod"));
    expect(acm.commandCalls(RequestCertificateCommand)).toHaveLength(0);
    expect(result.frontDoor!.domain).toEqual({ name: "app.other.dev", status: "dns-needed", records: [{ name: "app.other.dev", type: "CNAME", value: CF_DOMAIN }] });
  });

  it("refuses to overwrite a DNS record that points somewhere else", async () => {
    r53.on(ListHostedZonesCommand).resolves({ HostedZones: [{ Id: "/hostedzone/Z1", Name: "example.com.", CallerReference: "x" }] });
    r53.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: "app.example.com.", Type: "CNAME", ResourceRecords: [{ Value: "old-host.example.net" }] }] });
    acm.on(DescribeCertificateCommand).resolves({ Certificate: { Status: "ISSUED" } });
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ DomainName: "app.example.com", CertificateArn: CERT, Status: "ISSUED" }] });
    const project = fullStack("app.example.com");
    await expect(deploy(project, resolveStage(project, "prod"))).rejects.toThrow(/already has a CNAME record that points elsewhere/);
    expect(r53.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
  });

  it("leaves an unchanged distribution alone and clears the cache only when files changed", async () => {
    const project = fullStack();
    await deploy(project, resolveStage(project, "prod"));
    const desired = created();

    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [{ Id: "E1", ARN: DIST_ARN, DomainName: CF_DOMAIN, Comment: desired.Comment, Enabled: true }] } as any });
    cf.on(GetDistributionConfigCommand).resolves({ ETag: "ET1", DistributionConfig: desired });
    s3.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: "index.html", ETag: '"' + "0".repeat(32) + '"' },
        { Key: "assets/index-B3x9Kq7a.js", ETag: '"6114f5adc373accd7b2051bd87078f62"' },
        { Key: "assets/old-A1b2C3d4.js", ETag: '"x"' },
      ],
    });
    s3.resetHistory();
    const result = await deploy(project, resolveStage(project, "prod"));

    expect(cf.commandCalls(UpdateDistributionCommand)).toHaveLength(0);
    expect(result.frontDoor!.propagating).toBe(false);
    expect(result.frontDoor!.site!.stale).toBe(1);
    expect(s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input.Key)).toContain("index.html");
    expect(cf.commandCalls(CreateInvalidationCommand)[0]!.args[0].input.InvalidationBatch!.Paths).toEqual({ Quantity: 1, Items: ["/*"] });
  });

  it("stops before touching AWS when the frontend folder is missing", async () => {
    const project = withConfig({ static: { dir: "does-not-exist" } });
    await expect(deploy(project, resolveStage(project, "prod"))).rejects.toThrow(/static.dir "does-not-exist" doesn't exist/);
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(0);
  });
});

describe("destroy with a front door", () => {
  it("disables and deletes the distribution, then removes its DNS, certificate, functions and bucket", async () => {
    const summary = { Id: "E1", ARN: DIST_ARN, DomainName: CF_DOMAIN, Comment: "hatch:hono-fixture-prod abc", Enabled: true, Aliases: { Quantity: 1, Items: ["app.example.com"] } };
    cf.on(ListDistributionsCommand).resolves({ DistributionList: { Items: [summary] } as any });
    cf.on(GetDistributionConfigCommand).resolves({ ETag: "ET1", DistributionConfig: { Enabled: true } as any });
    cf.on(UpdateDistributionCommand).resolves({});
    cf.on(GetDistributionCommand)
      .resolvesOnce({ ETag: "ET2", Distribution: { Status: "InProgress", DistributionConfig: { Enabled: false } } as any })
      .resolves({ ETag: "ET3", Distribution: { Status: "Deployed", DistributionConfig: { Enabled: false } } as any });
    cf.on(DeleteDistributionCommand).resolves({});
    cf.on(DescribeFunctionCommand).resolves({ ETag: "FE" });
    cf.on(DeleteFunctionCommand).resolves({});
    r53.on(ListHostedZonesCommand).resolves({ HostedZones: [{ Id: "/hostedzone/Z1", Name: "example.com.", CallerReference: "x" }] });
    r53.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        { Name: "app.example.com.", Type: "A", AliasTarget: { HostedZoneId: "Z2FDTNDATAQYW2", DNSName: `${CF_DOMAIN}.`, EvaluateTargetHealth: false } },
        { Name: "app.example.com.", Type: "TXT", ResourceRecords: [{ Value: '"keep me"' }] },
      ],
    });
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ DomainName: "app.example.com", CertificateArn: CERT, Status: "ISSUED" }] });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [{ Key: "hatch:app", Value: "hono-fixture" }, { Key: "hatch:stage", Value: "prod" }] });
    acm.on(DeleteCertificateCommand).resolves({});
    s3.on(ListObjectsV2Command).resolves({ Contents: [] });
    s3.on(DeleteBucketCommand).resolves({});
    lw.on(GetWebFunctionCommand).rejects(notFound());
    lw.on(ListWebFunctionEndpointsCommand).resolves({ endpoints: [] });
    iam.on(GetRoleCommand).rejects(notFound("NoSuchEntityException"));

    const project = fullStack("app.example.com");
    await destroy(project, resolveStage(project, "prod"));

    expect(cf.commandCalls(UpdateDistributionCommand)[0]!.args[0].input).toMatchObject({ IfMatch: "ET1", DistributionConfig: { Enabled: false } });
    expect(cf.commandCalls(DeleteDistributionCommand)[0]!.args[0].input).toEqual({ Id: "E1", IfMatch: "ET3" });
    const deleted = r53.commandCalls(ChangeResourceRecordSetsCommand)[0]!.args[0].input.ChangeBatch!.Changes!;
    expect(deleted.map((c) => [c.Action, c.ResourceRecordSet!.Type])).toEqual([["DELETE", "A"]]);
    expect(acm.commandCalls(DeleteCertificateCommand)[0]!.args[0].input.CertificateArn).toBe(CERT);
    expect(cf.commandCalls(DeleteFunctionCommand).map((c) => c.args[0].input.Name)).toEqual(["hatch-hono-fixture-prod-fwd", "hatch-hono-fixture-prod-site"]);
    expect(s3.commandCalls(DeleteBucketCommand)[0]!.args[0].input.Bucket).toBe("hatch-site-123456789012-hono-fixture-prod");
  });

  it("keeps a certificate it didn't create", async () => {
    acm.on(ListCertificatesCommand).resolves({ CertificateSummaryList: [{ DomainName: "app.example.com", CertificateArn: CERT, Status: "ISSUED" }] });
    acm.on(ListTagsForCertificateCommand).resolves({ Tags: [] });
    s3.on(HeadBucketCommand).rejects(notFound("NotFound"));
    lw.on(GetWebFunctionCommand).rejects(notFound());
    iam.on(GetRoleCommand).rejects(notFound("NoSuchEntityException"));
    const project = fullStack("app.example.com");
    await destroy(project, resolveStage(project, "prod"));
    expect(acm.commandCalls(DeleteCertificateCommand)).toHaveLength(0);
  });
});

describe("serve behind the front door", () => {
  let served: Served | undefined;
  afterEach(async () => {
    await served?.close();
    served = undefined;
    delete process.env.HATCH_FRONT_DOOR;
  });

  it("builds request URLs from the viewer's host", async () => {
    process.env.HATCH_FRONT_DOOR = "1";
    served = await serve({ fetch: (req: Request) => new Response(req.url) }, { port: 0, requestLog: false });
    const res = await fetch(`http://127.0.0.1:${served.port}/api/me?x=1`, { headers: { "x-forwarded-host": "app.example.com" } });
    expect(await res.text()).toBe("https://app.example.com/api/me?x=1");
  });

  it("ignores x-forwarded-host without a front door", async () => {
    served = await serve({ fetch: (req: Request) => new Response(new URL(req.url).host) }, { port: 0, requestLog: false });
    const res = await fetch(`http://127.0.0.1:${served.port}/`, { headers: { "x-forwarded-host": "evil.example" } });
    expect(await res.text()).toBe(`127.0.0.1:${served.port}`);
  });
});
