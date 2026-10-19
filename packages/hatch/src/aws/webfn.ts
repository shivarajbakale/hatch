import {
  CreateWebFunctionCommand,
  CreateWebFunctionEndpointCommand,
  CreateWebFunctionRevisionCommand,
  DeleteWebFunctionCommand,
  DeleteWebFunctionEndpointCommand,
  GetWebFunctionCommand,
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  ListWebFunctionEndpointsCommand,
  ListWebFunctionRevisionsCommand,
  UpdateWebFunctionEndpointCommand,
  type FunctionRevisionSummary,
  type GetWebFunctionEndpointResponse,
  type RevisionConfig,
  type RevisionWeight,
} from "@aws-sdk/client-lambda-web";
import { aws, isNotFound, waitFor } from "./clients.js";

export const ENDPOINT_NAME = "main";
export const RUNTIME = "nodejs24.x";

export type Endpoint = GetWebFunctionEndpointResponse;

export async function functionExists(region: string, functionName: string): Promise<boolean> {
  try {
    await aws.lambdaWeb(region).send(new GetWebFunctionCommand({ functionName }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

export function endpointShape(regions: string[]) {
  // A MultiRegion endpoint needs at least one region besides home; one region means HomeRegion.
  return regions.length > 1 ? { endpointType: "MultiRegion" as const, regions } : { endpointType: "HomeRegion" as const };
}

export async function createFunction(
  region: string,
  functionName: string,
  revisionConfig: RevisionConfig,
  regions: string[],
  tags: Record<string, string>,
): Promise<string> {
  const out = await aws.lambdaWeb(region).send(
    new CreateWebFunctionCommand({
      functionName,
      revisionConfig,
      endpointConfig: {
        endpointName: ENDPOINT_NAME,
        authType: "ApplicationManaged",
        // hatch sets revision weights itself so canaries and rollbacks stay explicit.
        autoDeploymentMode: "Disabled",
        ...endpointShape(regions),
      },
      tags,
    }),
  );
  const revisionId = out.revision?.revisionId;
  if (!revisionId) throw new Error("CreateWebFunction returned no revision");
  return revisionId;
}

export async function createRevision(region: string, functionName: string, revisionConfig: RevisionConfig): Promise<string> {
  const out = await aws.lambdaWeb(region).send(
    new CreateWebFunctionRevisionCommand({
      functionName,
      description: revisionConfig.description,
      kmsKeyArn: revisionConfig.kmsKeyArn,
      buildConfig: revisionConfig.buildConfig,
      serviceConfig: revisionConfig.serviceConfig,
    }),
  );
  if (!out.revisionId) throw new Error("CreateWebFunctionRevision returned no revision id");
  return out.revisionId;
}

export async function waitForRevision(region: string, functionName: string, revisionId: string): Promise<void> {
  await waitFor(`revision ${revisionId}`, async () => {
    const rev = await aws.lambdaWeb(region).send(new GetWebFunctionRevisionCommand({ functionName, revisionId }));
    if (rev.state === "Failed") {
      const details = (rev.errors ?? []).map((e) => `${e.attribute}: ${e.errorMessage}`).join("; ");
      throw new Error(`Revision ${revisionId} failed: ${rev.stateReason ?? ""} ${details}`.trim());
    }
    return rev.state === "Active" ? true : undefined;
  });
}

export async function getEndpoint(region: string, functionName: string): Promise<Endpoint | undefined> {
  try {
    return await aws.lambdaWeb(region).send(new GetWebFunctionEndpointCommand({ functionName, endpointName: ENDPOINT_NAME }));
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

/** Waits until the endpoint is Active and no update is in flight. */
export async function waitForEndpoint(region: string, functionName: string): Promise<Endpoint> {
  return waitFor("endpoint", async () => {
    const ep = await getEndpoint(region, functionName);
    if (!ep) return undefined;
    if (ep.state === "Failed") throw new Error(`Endpoint failed: ${ep.stateReason ?? "unknown reason"}`);
    if (ep.updateStatus === "Failed") throw new Error(`Endpoint update failed: ${ep.updateStatusReason ?? "unknown reason"}`);
    if (ep.state !== "Active" || ep.updateStatus === "InProgress") return undefined;
    return ep;
  });
}

export async function createEndpoint(region: string, functionName: string, regions: string[], weights: RevisionWeight[]): Promise<void> {
  await aws.lambdaWeb(region).send(
    new CreateWebFunctionEndpointCommand({
      functionName,
      endpointName: ENDPOINT_NAME,
      authType: "ApplicationManaged",
      autoDeploymentMode: "Disabled",
      revisionWeights: weights,
      ...endpointShape(regions),
    }),
  );
}

export async function setWeights(region: string, functionName: string, weights: RevisionWeight[]): Promise<Endpoint> {
  await aws.lambdaWeb(region).send(
    new UpdateWebFunctionEndpointCommand({ functionName, endpointName: ENDPOINT_NAME, autoDeploymentMode: "Disabled", revisionWeights: weights }),
  );
  return waitForEndpoint(region, functionName);
}

export async function listRevisions(region: string, functionName: string): Promise<FunctionRevisionSummary[]> {
  const out: FunctionRevisionSummary[] = [];
  let nextToken: string | undefined;
  do {
    const page = await aws.lambdaWeb(region).send(new ListWebFunctionRevisionsCommand({ functionName, nextToken }));
    out.push(...(page.revisions ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return out.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

export async function deleteFunction(region: string, functionName: string): Promise<boolean> {
  const lw = aws.lambdaWeb(region);
  if (!(await functionExists(region, functionName))) return false;
  const endpoints = await lw.send(new ListWebFunctionEndpointsCommand({ functionName }));
  for (const ep of endpoints.endpoints ?? []) {
    await lw.send(new DeleteWebFunctionEndpointCommand({ functionName, endpointName: ep.endpointName }));
  }
  await lw.send(new DeleteWebFunctionCommand({ functionName }));
  await waitFor("function deletion", async () => ((await functionExists(region, functionName)) ? undefined : true));
  return true;
}

export function endpointUrl(ep: Pick<Endpoint, "domainName">): string | undefined {
  return ep.domainName ? `https://${ep.domainName}` : undefined;
}
