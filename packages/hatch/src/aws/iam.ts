import { createHash } from "node:crypto";
import { CreateRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, GetRoleCommand, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import { aws, isNotFound } from "./clients.js";

export const DEFAULT_TRUST_PRINCIPAL = "lambda.amazonaws.com";
const POLICY_NAME = "hatch-runtime";

/** Readable when it fits; otherwise truncated plus a hash, so "pr-42" and "pr-421" never share a role. */
export function roleName(functionName: string): string {
  const full = `hatch-${functionName}`;
  if (full.length <= 64) return full;
  const hash = createHash("sha256").update(functionName).digest("hex").slice(0, 8);
  return `${full.slice(0, 55)}-${hash}`;
}

export interface RolePermissions {
  account: string;
  functionName: string;
  kvTables: string[];
}

/** Least-privilege policy: write its own logs, and read/write only the kv tables the code uses. */
export function runtimePolicy({ account, functionName, kvTables }: RolePermissions): string {
  const statements: object[] = [
    {
      Sid: "Logs",
      Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: [`arn:aws:logs:*:${account}:log-group:/aws/lambda/web/${functionName}`, `arn:aws:logs:*:${account}:log-group:/aws/lambda/web/${functionName}:*`],
    },
  ];
  if (kvTables.length) {
    statements.push({
      Sid: "KV",
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"],
      Resource: kvTables.map((t) => `arn:aws:dynamodb:*:${account}:table/${t}`),
    });
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

function trustPolicy(principal: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: principal }, Action: "sts:AssumeRole" }],
  });
}

/** Creates or updates the execution role. Returns its ARN and whether it was just created. */
export async function ensureRole(perms: RolePermissions, principal = DEFAULT_TRUST_PRINCIPAL): Promise<{ arn: string; created: boolean }> {
  const iam = aws.iam();
  const name = roleName(perms.functionName);
  let arn: string | undefined;
  let created = false;
  try {
    const out = await iam.send(new GetRoleCommand({ RoleName: name }));
    arn = out.Role?.Arn;
    await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: name, PolicyDocument: trustPolicy(principal) }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    const out = await iam.send(
      new CreateRoleCommand({
        RoleName: name,
        AssumeRolePolicyDocument: trustPolicy(principal),
        Description: `Execution role for the ${perms.functionName} web function (managed by hatch)`,
        Tags: [{ Key: "hatch:function", Value: perms.functionName }],
      }),
    );
    arn = out.Role?.Arn;
    created = true;
  }
  await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: POLICY_NAME, PolicyDocument: runtimePolicy(perms) }));
  if (!arn) throw new Error(`IAM returned no ARN for role ${name}`);
  return { arn, created };
}

export async function deleteRole(functionName: string): Promise<void> {
  const iam = aws.iam();
  const name = roleName(functionName);
  try {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: POLICY_NAME }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await iam.send(new DeleteRoleCommand({ RoleName: name }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
