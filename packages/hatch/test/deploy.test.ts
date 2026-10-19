import path from "node:path";
import { CreateTableCommand, DescribeTableCommand, ListTablesCommand, ListTagsOfResourceCommand, DescribeTimeToLiveCommand, DynamoDBClient, UpdateTableCommand, UpdateTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { CreateRoleCommand, GetRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  CreateWebFunctionCommand,
  CreateWebFunctionRevisionCommand,
  GetWebFunctionCommand,
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  LambdaWebClient,
  ListWebFunctionRevisionsCommand,
  UpdateWebFunctionEndpointCommand,
} from "@aws-sdk/client-lambda-web";
import { CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetClients } from "../src/aws/clients.js";
import { loadProject, resolveStage, type Project } from "../src/build/project.js";
import { deploy, kvTablePrefix, promote, rollback, tags } from "../src/deploy.js";
import { listKvTables } from "../src/aws/dynamo.js";

const lw = mockClient(LambdaWebClient);
const s3 = mockClient(S3Client);
const ddb = mockClient(DynamoDBClient);
const iam = mockClient(IAMClient);
const ssm = mockClient(SSMClient);
const sts = mockClient(STSClient);

const notFound = (name = "ResourceNotFoundException") => Object.assign(new Error(name), { name });
const fixture = path.resolve(import.meta.dirname, "fixtures", "hono-app");

let project: Project;

beforeAll(async () => {
  process.env.HATCH_POLL_MS = "1";
  process.env.HATCH_IAM_RETRY_MS = "1";
  project = await loadProject(fixture);
});

afterAll(() => {
  delete process.env.HATCH_POLL_MS;
  delete process.env.HATCH_IAM_RETRY_MS;
});

beforeEach(() => {
  for (const m of [lw, s3, ddb, iam, ssm, sts]) m.reset();
  resetClients();
  sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012" });
  s3.on(HeadBucketCommand).resolves({});
  s3.on(HeadObjectCommand).rejects(notFound("NotFound"));
  s3.on(PutObjectCommand).resolves({});
  ddb.on(DescribeTableCommand).resolves({ Table: { TableStatus: "ACTIVE", Replicas: [] } });
  ddb.on(DescribeTimeToLiveCommand).resolves({ TimeToLiveDescription: { TimeToLiveStatus: "ENABLED" } });
  ssm.on(GetParametersByPathCommand).resolves({ Parameters: [{ Name: "/hatch/hono-fixture/prod/API_KEY", Value: "sk_live" }] });
  iam.on(GetRoleCommand).resolves({ Role: { Arn: "arn:aws:iam::123456789012:role/hatch-hono-fixture-prod" } as any });
  iam.on(PutRolePolicyCommand).resolves({});
  lw.on(GetWebFunctionRevisionCommand).resolves({ state: "Active" });
  lw.on(UpdateWebFunctionEndpointCommand).resolves({});
});

const history = () =>
  [
    { revisionId: "rev-1", state: "Active", createdAt: new Date("2026-10-01") },
    { revisionId: "rev-2", state: "Active", createdAt: new Date("2026-10-02") },
  ] as any;

const endpoint = (weights: { revisionId: string; weight: number }[]) => ({
  state: "Active" as const,
  updateStatus: "Successful" as const,
  domainName: "abc.def.lambda-web.us-east-1.on.aws",
  regions: ["us-east-1"],
  revisionWeights: weights,
});

describe("first deploy", () => {
  it("creates bucket, table, role and function, then routes 100% to the first revision", async () => {
    s3.reset();
    s3.on(HeadBucketCommand).rejects(notFound("NotFound"));
    s3.on(CreateBucketCommand).resolves({});
    s3.on(HeadObjectCommand).rejects(notFound("NotFound"));
    s3.on(PutObjectCommand).resolves({});
    ddb.on(DescribeTableCommand).rejectsOnce(notFound()).resolves({ Table: { TableStatus: "ACTIVE", Replicas: [] } });
    ddb.on(CreateTableCommand).resolves({});
    ddb.on(DescribeTimeToLiveCommand).resolves({ TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } });
    ddb.on(UpdateTimeToLiveCommand).resolves({});
    iam.on(GetRoleCommand).rejects(notFound("NoSuchEntityException"));
    iam.on(CreateRoleCommand).resolves({ Role: { Arn: "arn:aws:iam::123456789012:role/new" } as any });
    lw.on(GetWebFunctionCommand).rejects(notFound());
    // A brand-new role isn't assumable for a few seconds; the first attempt fails like that.
    lw.on(CreateWebFunctionCommand)
      .rejectsOnce(Object.assign(new Error("The role defined for the function cannot be assumed by Lambda."), { name: "ValidationException" }))
      .resolves({ revision: { revisionId: "rev-1" } as any });
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([]));

    const steps: string[] = [];
    const stage = resolveStage(project, "prod");
    const result = await deploy(project, stage, { onStep: (s) => steps.push(s) });

    expect(result).toMatchObject({ revisionId: "rev-1", firstDeploy: true, url: "https://abc.def.lambda-web.us-east-1.on.aws", weights: [{ revisionId: "rev-1", weight: 100 }] });
    expect(s3.commandCalls(CreateBucketCommand)[0]!.args[0].input.Bucket).toBe("hatch-artifacts-123456789012-us-east-1");
    expect(ddb.commandCalls(CreateTableCommand)[0]!.args[0].input).toMatchObject({ TableName: "hono-fixture-prod-kv-counters", BillingMode: "PAY_PER_REQUEST" });
    expect(ddb.commandCalls(UpdateTimeToLiveCommand)).toHaveLength(1);

    const policy = JSON.parse(iam.commandCalls(PutRolePolicyCommand)[0]!.args[0].input.PolicyDocument!);
    expect(policy.Statement.find((s: any) => s.Sid === "KV").Resource).toEqual(["arn:aws:dynamodb:*:123456789012:table/hono-fixture-prod-kv-counters"]);

    const create = lw.commandCalls(CreateWebFunctionCommand);
    expect(create).toHaveLength(2);
    const input = create[1]!.args[0].input;
    expect(input.functionName).toBe("hono-fixture-prod");
    expect(input.endpointConfig).toMatchObject({ endpointName: "main", endpointType: "HomeRegion", authType: "ApplicationManaged", autoDeploymentMode: "Disabled" });
    expect(input.revisionConfig!.buildConfig).toMatchObject({ runtimeConfig: { runtime: "nodejs24.x" }, codeConfig: { s3Object: { bucket: "hatch-artifacts-123456789012-us-east-1" } } });
    expect(input.revisionConfig!.serviceConfig!.environmentVariables).toMatchObject({
      HATCH_APP: "hono-fixture",
      HATCH_STAGE: "prod",
      HATCH_KV_COUNTERS: "hono-fixture-prod-kv-counters",
      HATCH_SECRET_API_KEY: "sk_live",
    });
    expect(lw.commandCalls(UpdateWebFunctionEndpointCommand)[0]!.args[0].input.revisionWeights).toEqual([{ revisionId: "rev-1", weight: 100 }]);
    expect(steps[0]).toMatch(/^Building src\/index.ts \(hono\)/);
  });

  it("fails before touching the function when a secret is missing", async () => {
    ssm.on(GetParametersByPathCommand).resolves({ Parameters: [] });
    await expect(deploy(project, resolveStage(project, "prod"))).rejects.toThrow(/hatch secrets set API_KEY <value> --stage prod/);
    expect(lw.commandCalls(CreateWebFunctionCommand)).toHaveLength(0);
    expect(lw.commandCalls(CreateWebFunctionRevisionCommand)).toHaveLength(0);
  });

  it("creates a MultiRegion endpoint and global-table replicas for several regions", async () => {
    ddb.on(DescribeTableCommand).resolves({ Table: { TableStatus: "ACTIVE", Replicas: [] } });
    ddb.on(UpdateTableCommand).resolves({});
    lw.on(GetWebFunctionCommand).rejects(notFound());
    lw.on(CreateWebFunctionCommand).resolves({ revision: { revisionId: "rev-1" } as any });
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([]));

    await deploy(project, resolveStage(project, "prod", ["us-east-1", "eu-west-1", "ap-northeast-1"]));
    expect(lw.commandCalls(CreateWebFunctionCommand)[0]!.args[0].input.endpointConfig).toMatchObject({
      endpointType: "MultiRegion",
      regions: ["us-east-1", "eu-west-1", "ap-northeast-1"],
    });
    const replicaCalls = ddb.commandCalls(UpdateTableCommand).filter((c) => c.args[0].input.ReplicaUpdates);
    expect(replicaCalls.map((c) => c.args[0].input.ReplicaUpdates![0]!.Create!.RegionName)).toEqual(["eu-west-1", "ap-northeast-1"]);
  });
});

describe("later deploys", () => {
  beforeEach(() => {
    lw.on(GetWebFunctionCommand).resolves({ functionName: "hono-fixture-prod" });
    lw.on(CreateWebFunctionRevisionCommand).resolves({ revisionId: "rev-2" });
  });

  it("creates a revision and moves all traffic to it", async () => {
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([{ revisionId: "rev-1", weight: 100 }]));
    const result = await deploy(project, resolveStage(project, "prod"));
    expect(result).toMatchObject({ revisionId: "rev-2", firstDeploy: false });
    expect(lw.commandCalls(UpdateWebFunctionEndpointCommand)[0]!.args[0].input.revisionWeights).toEqual([{ revisionId: "rev-2", weight: 100 }]);
  });

  it("splits traffic for a canary, then promote sends everything to it", async () => {
    lw.on(ListWebFunctionRevisionsCommand).resolves({ revisions: history() });
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([{ revisionId: "rev-1", weight: 100 }]));
    const result = await deploy(project, resolveStage(project, "prod"), { canary: 10 });
    expect(result.weights).toEqual([
      { revisionId: "rev-1", weight: 90 },
      { revisionId: "rev-2", weight: 10 },
    ]);

    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint(result.weights as any));
    await promote(resolveStage(project, "prod"));
    expect(lw.commandCalls(UpdateWebFunctionEndpointCommand).at(-1)!.args[0].input.revisionWeights).toEqual([{ revisionId: "rev-2", weight: 100 }]);
  });

  it("surfaces a failed revision with its errors", async () => {
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([{ revisionId: "rev-1", weight: 100 }]));
    lw.on(GetWebFunctionRevisionCommand).resolves({ state: "Failed", stateReason: "Build failed", errors: [{ attribute: "runtime", errorCode: "X", errorMessage: "bad runtime" }] });
    await expect(deploy(project, resolveStage(project, "prod"))).rejects.toThrow("Revision rev-2 failed: Build failed runtime: bad runtime");
    expect(lw.commandCalls(UpdateWebFunctionEndpointCommand)).toHaveLength(0);
  });
});

describe("rollback", () => {
  it("ends a canary by returning everything to the stable revision", async () => {
    lw.on(ListWebFunctionRevisionsCommand).resolves({ revisions: history() });
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([{ revisionId: "rev-1", weight: 90 }, { revisionId: "rev-2", weight: 10 }]));
    expect(await rollback(resolveStage(project, "prod"))).toEqual({ from: "rev-2", to: "rev-1" });
    expect(lw.commandCalls(UpdateWebFunctionEndpointCommand)[0]!.args[0].input.revisionWeights).toEqual([{ revisionId: "rev-1", weight: 100 }]);
  });

  it("handles a canary that already has most of the traffic", async () => {
    lw.on(ListWebFunctionRevisionsCommand).resolves({ revisions: history() });
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([{ revisionId: "rev-1", weight: 20 }, { revisionId: "rev-2", weight: 80 }]));
    expect(await rollback(resolveStage(project, "prod"))).toEqual({ from: "rev-2", to: "rev-1" });
    lw.on(UpdateWebFunctionEndpointCommand).resolves({});
    await promote(resolveStage(project, "prod"));
    expect(lw.commandCalls(UpdateWebFunctionEndpointCommand).at(-1)!.args[0].input.revisionWeights).toEqual([{ revisionId: "rev-2", weight: 100 }]);
  });

  it("goes back to the previous Active revision", async () => {
    lw.on(GetWebFunctionEndpointCommand).resolves(endpoint([{ revisionId: "rev-3", weight: 100 }]));
    lw.on(ListWebFunctionRevisionsCommand).resolves({
      revisions: [
        { revisionId: "rev-1", state: "Active", createdAt: new Date("2026-10-01") },
        { revisionId: "rev-2", state: "Failed", createdAt: new Date("2026-10-02") },
        { revisionId: "rev-3", state: "Active", createdAt: new Date("2026-10-03") },
      ] as any,
    });
    expect(await rollback(resolveStage(project, "prod"))).toEqual({ from: "rev-3", to: "rev-1" });
  });
});

describe("kv tables", () => {
  it("turns on streams before adding a replica to a table created for one region", async () => {
    lw.on(GetWebFunctionCommand).resolves({});
    lw.on(CreateWebFunctionRevisionCommand).resolves({ revisionId: "rev-2" });
    lw.on(GetWebFunctionEndpointCommand).resolves({ ...endpoint([{ revisionId: "rev-1", weight: 100 }]), regions: ["us-east-1", "eu-west-1"] });
    ddb.on(DescribeTableCommand).resolves({ Table: { TableStatus: "ACTIVE", Replicas: [] } });
    ddb.on(UpdateTableCommand).resolves({});
    await deploy(project, resolveStage(project, "prod", ["us-east-1", "eu-west-1"]));
    const updates = ddb.commandCalls(UpdateTableCommand).map((c) => c.args[0].input);
    expect(updates[0]!.StreamSpecification).toEqual({ StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" });
    expect(updates[1]!.ReplicaUpdates).toEqual([{ Create: { RegionName: "eu-west-1" } }]);
  });

  it("purges only tables tagged with this app and stage", async () => {
    ddb.on(ListTablesCommand).resolves({ TableNames: ["hono-fixture-prod-kv-a", "hono-fixture-prod-kv-x-kv-b", "other"] });
    ddb.on(DescribeTableCommand).callsFake((input) => ({ Table: { TableArn: `arn:${input.TableName}`, TableStatus: "ACTIVE" } }));
    ddb.on(ListTagsOfResourceCommand).callsFake((input) => ({
      Tags: [
        { Key: "hatch:app", Value: "hono-fixture" },
        { Key: "hatch:stage", Value: input.ResourceArn.includes("x-kv") ? "prod-kv-x" : "prod" },
      ],
    }));
    const stage = resolveStage(project, "prod");
    expect(await listKvTables(kvTablePrefix(project, stage), "us-east-1", tags(project, stage))).toEqual(["hono-fixture-prod-kv-a"]);
  });
});

describe("stage validation", () => {
  it("rejects regions without Web Functions", () => {
    expect(() => resolveStage(project, "prod", ["ap-south-1"])).toThrow(/aren't available in ap-south-1/);
  });
});
