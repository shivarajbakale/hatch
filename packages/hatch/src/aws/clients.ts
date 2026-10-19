import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaWebClient } from "@aws-sdk/client-lambda-web";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const cache = new Map<string, unknown>();

function memo<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

export const aws = {
  lambdaWeb: (region: string) => memo(`lw:${region}`, () => new LambdaWebClient({ region })),
  s3: (region: string) => memo(`s3:${region}`, () => new S3Client({ region })),
  dynamo: (region: string) => memo(`ddb:${region}`, () => new DynamoDBClient({ region })),
  ssm: (region: string) => memo(`ssm:${region}`, () => new SSMClient({ region })),
  logs: (region: string) => memo(`logs:${region}`, () => new CloudWatchLogsClient({ region })),
  iam: () => memo("iam", () => new IAMClient({ region: "us-east-1" })),
  sts: (region: string) => memo(`sts:${region}`, () => new STSClient({ region })),
};

/** Drops cached clients; tests call this between cases. */
export function resetClients(): void {
  cache.clear();
}

export async function accountId(region: string): Promise<string> {
  const out = await aws.sts(region).send(new GetCallerIdentityCommand({}));
  if (!out.Account) throw new Error("Could not read the AWS account id. Are credentials configured?");
  return out.Account;
}

export function isNotFound(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  return /NotFound|NoSuchEntity|NoSuchBucket|ParameterNotFound/.test(name) || (err as any)?.$metadata?.httpStatusCode === 404;
}

export function pollInterval(): number {
  return Number(process.env.HATCH_POLL_MS ?? 2000);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it returns a value, or throws after `timeoutMs`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 10 * 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(pollInterval());
  }
}
