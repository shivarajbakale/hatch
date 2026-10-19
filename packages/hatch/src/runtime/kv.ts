import fs from "node:fs";
import path from "node:path";
import { runtimeInfo } from "./context.js";

export interface SetOptions {
  /** Seconds until the key expires. */
  ttl?: number;
}

export interface KV<T = unknown> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, options?: SetOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Entry {
  v: unknown;
  exp?: number;
}

/** File-backed store used by `hatch dev` and tests. Survives restarts in .hatch/dev/. */
export class LocalKV<T = unknown> implements KV<T> {
  private data = new Map<string, Entry>();
  private loaded = false;

  constructor(private readonly file?: string) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.file && fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, Entry>;
      this.data = new Map(Object.entries(raw));
    }
  }

  private persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)));
  }

  async get(key: string): Promise<T | undefined> {
    this.load();
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.exp !== undefined && entry.exp <= Date.now()) {
      this.data.delete(key);
      this.persist();
      return undefined;
    }
    return entry.v as T;
  }

  async set(key: string, value: T, options?: SetOptions): Promise<void> {
    this.load();
    this.data.set(key, { v: value, exp: options?.ttl ? Date.now() + options.ttl * 1000 : undefined });
    this.persist();
  }

  async delete(key: string): Promise<void> {
    this.load();
    this.data.delete(key);
    this.persist();
  }
}

/**
 * DynamoDB-backed store. Items: { pk: S, v: S (JSON), ttl?: N (epoch seconds) }.
 * DynamoDB deletes expired items lazily, so reads also check `ttl`.
 */
export class DynamoKV<T = unknown> implements KV<T> {
  private client: Promise<typeof import("@aws-sdk/client-dynamodb") & { instance: any }> | undefined;

  constructor(private readonly table: string) {}

  private sdk() {
    this.client ??= import("@aws-sdk/client-dynamodb").then((mod) => ({
      ...mod,
      instance: new mod.DynamoDBClient({}),
    }));
    return this.client;
  }

  async get(key: string): Promise<T | undefined> {
    const { GetItemCommand, instance } = await this.sdk();
    const out = await instance.send(new GetItemCommand({ TableName: this.table, Key: { pk: { S: key } } }));
    const item = out.Item;
    if (!item?.v?.S) return undefined;
    if (item.ttl?.N && Number(item.ttl.N) <= Math.floor(Date.now() / 1000)) return undefined;
    return JSON.parse(item.v.S) as T;
  }

  async set(key: string, value: T, options?: SetOptions): Promise<void> {
    const { PutItemCommand, instance } = await this.sdk();
    const item: Record<string, any> = { pk: { S: key }, v: { S: JSON.stringify(value) } };
    if (options?.ttl) item.ttl = { N: String(Math.floor(Date.now() / 1000) + options.ttl) };
    await instance.send(new PutItemCommand({ TableName: this.table, Item: item }));
  }

  async delete(key: string): Promise<void> {
    const { DeleteItemCommand, instance } = await this.sdk();
    await instance.send(new DeleteItemCommand({ TableName: this.table, Key: { pk: { S: key } } }));
  }
}

/** Table name convention shared by the runtime and the deployer. */
export function kvTableName(app: string, stage: string, name: string): string {
  return `${app}-${stage}-kv-${name}`;
}

export function kvEnvVar(name: string): string {
  return `HATCH_KV_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * A key-value store. `hatch deploy` finds every `kv("name")` call and creates a DynamoDB table
 * (a global table when you deploy to several regions). Under `hatch dev` it is a local file.
 */
export function kv<T = unknown>(name: string): KV<T> {
  if (!NAME.test(name)) throw new Error(`kv name "${name}" must be lowercase letters, digits or dashes`);
  if (runtimeInfo.isDev || process.env.HATCH_KV_BACKEND === "local") {
    const dir = process.env.HATCH_DEV_DIR ?? path.join(process.cwd(), ".hatch", "dev");
    return new LocalKV<T>(path.join(dir, `kv-${name}.json`));
  }
  const table = process.env[kvEnvVar(name)];
  if (!table) {
    if (process.env.AWS_LAMBDA_HTTP_ENDPOINT && process.env.HATCH_APP) {
      // Deployed by hatch but this table wasn't provisioned: memory here would silently lose writes.
      throw new Error(`kv("${name}") has no table in this deploy. Use a string literal name so hatch can find it, then redeploy.`);
    }
    // Not deployed by hatch (a plain `node` run): memory keeps the app booting.
    return new LocalKV<T>();
  }
  return new DynamoKV<T>(table);
}
