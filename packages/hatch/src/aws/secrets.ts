import { DeleteParameterCommand, GetParametersByPathCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { aws, isNotFound } from "./clients.js";

export function secretsPath(app: string, stage: string): string {
  return `/hatch/${app}/${stage}/`;
}

/** All secrets for a stage, decrypted. Lives in the stage's home region. */
export async function readSecrets(region: string, app: string, stage: string): Promise<Record<string, string>> {
  const ssm = aws.ssm(region);
  const prefix = secretsPath(app, stage);
  const out: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, NextToken }));
    for (const p of page.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) out[p.Name.slice(prefix.length)] = p.Value;
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return out;
}

export async function writeSecret(region: string, app: string, stage: string, name: string, value: string): Promise<void> {
  await aws.ssm(region).send(
    new PutParameterCommand({ Name: secretsPath(app, stage) + name, Value: value, Type: "SecureString", Overwrite: true }),
  );
}

export async function deleteSecret(region: string, app: string, stage: string, name: string): Promise<boolean> {
  try {
    await aws.ssm(region).send(new DeleteParameterCommand({ Name: secretsPath(app, stage) + name }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}
