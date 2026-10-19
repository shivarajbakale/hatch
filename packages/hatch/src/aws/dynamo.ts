import {
  CreateTableCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  type TableDescription,
} from "@aws-sdk/client-dynamodb";
import { aws, isNotFound, waitFor } from "./clients.js";

async function describe(region: string, table: string): Promise<TableDescription | undefined> {
  try {
    return (await aws.dynamo(region).send(new DescribeTableCommand({ TableName: table }))).Table;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

function settled(desc: TableDescription | undefined): TableDescription | undefined {
  if (!desc || desc.TableStatus !== "ACTIVE") return undefined;
  if (desc.Replicas?.some((r) => r.ReplicaStatus !== "ACTIVE")) return undefined;
  return desc;
}

/**
 * Creates the kv table in the home region and adds a replica in every other region, which makes
 * it a DynamoDB global table. Idempotent: existing tables only get missing replicas added.
 */
export async function ensureKvTable(table: string, homeRegion: string, regions: string[], tags: Record<string, string>): Promise<"created" | "updated" | "unchanged"> {
  const ddb = aws.dynamo(homeRegion);
  let desc = await describe(homeRegion, table);
  let result: "created" | "updated" | "unchanged" = "unchanged";
  if (!desc) {
    await ddb.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        // Global tables replicate through streams.
        ...(regions.length > 1 ? { StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } } : {}),
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
    result = "created";
  }
  // Also covers a table (or replica) left CREATING/UPDATING by an interrupted earlier deploy.
  desc = await waitFor(`table ${table}`, async () => settled(await describe(homeRegion, table)));

  const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: table }));
  const ttlStatus = ttl.TimeToLiveDescription?.TimeToLiveStatus;
  if (ttlStatus !== "ENABLED" && ttlStatus !== "ENABLING") {
    await ddb.send(new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } }));
  }

  const existing = new Set([homeRegion, ...(desc.Replicas ?? []).map((r) => r.RegionName!)]);
  const missing = regions.filter((r) => !existing.has(r));
  if (missing.length && !desc.StreamSpecification?.StreamEnabled) {
    // A table created for one region has no stream; replicas need one.
    await ddb.send(new UpdateTableCommand({ TableName: table, StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } }));
    await waitFor(`stream on ${table}`, async () => settled(await describe(homeRegion, table)));
  }
  for (const region of missing) {
    // DynamoDB accepts one replica change per UpdateTable call.
    await ddb.send(new UpdateTableCommand({ TableName: table, ReplicaUpdates: [{ Create: { RegionName: region } }] }));
    await waitFor(`replica of ${table} in ${region}`, async () => settled(await describe(homeRegion, table)));
    result = result === "created" ? "created" : "updated";
  }
  return result;
}

export async function deleteKvTable(table: string, homeRegion: string): Promise<void> {
  const desc = await describe(homeRegion, table);
  if (!desc) return;
  // A global table's replicas have to go before the table itself.
  for (const replica of desc.Replicas ?? []) {
    if (replica.RegionName === homeRegion) continue;
    await aws.dynamo(homeRegion).send(new UpdateTableCommand({ TableName: table, ReplicaUpdates: [{ Delete: { RegionName: replica.RegionName } }] }));
    await waitFor(`removal of ${table} replica in ${replica.RegionName}`, async () => settled(await describe(homeRegion, table)));
  }
  try {
    await aws.dynamo(homeRegion).send(new DeleteTableCommand({ TableName: table }));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * Every kv table of a stage, including ones the code no longer uses. Candidates come from the name
 * prefix; the hatch:app/hatch:stage tags confirm ownership (stage "b" must not match stage "b-kv-x").
 */
export async function listKvTables(prefix: string, homeRegion: string, tags: Record<string, string>): Promise<string[]> {
  const ddb = aws.dynamo(homeRegion);
  const candidates: string[] = [];
  let ExclusiveStartTableName: string | undefined;
  do {
    const page = await ddb.send(new ListTablesCommand({ ExclusiveStartTableName }));
    candidates.push(...(page.TableNames ?? []).filter((t) => t.startsWith(prefix)));
    ExclusiveStartTableName = page.LastEvaluatedTableName;
  } while (ExclusiveStartTableName);

  const out: string[] = [];
  for (const table of candidates) {
    const arn = (await describe(homeRegion, table))?.TableArn;
    if (!arn) continue;
    const { Tags = [] } = await ddb.send(new ListTagsOfResourceCommand({ ResourceArn: arn }));
    if (Object.entries(tags).every(([k, v]) => Tags.some((t) => t.Key === k && t.Value === v))) out.push(table);
  }
  return out;
}
