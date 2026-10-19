import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { aws, isNotFound } from "./clients.js";

/** S3 bucket names are global and at most 63 characters. Long names keep a readable prefix plus a hash. */
export function siteBucketName(account: string, functionName: string): string {
  const full = `hatch-site-${account}-${functionName}`;
  if (full.length <= 63) return full;
  const hash = createHash("sha256").update(functionName).digest("hex").slice(0, 8);
  return `${full.slice(0, 54).replace(/-+$/, "")}-${hash}`;
}

export function siteBucketDomain(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

/** A private bucket for one stage's frontend. Only that stage's CloudFront distribution may read it. */
export async function ensureSiteBucket(bucket: string, region: string, account: string, tags: Record<string, string>): Promise<void> {
  const s3 = aws.s3(region);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: account }));
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucket,
      ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
    }),
  );
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    }),
  );
  await s3.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } }));
}

/** Lets exactly one CloudFront distribution read the bucket, through origin access control. */
export async function allowDistribution(bucket: string, region: string, distributionArn: string): Promise<void> {
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "HatchCloudFrontRead",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
        Condition: { StringEquals: { "AWS:SourceArn": distributionArn } },
      },
    ],
  };
  await aws.s3(region).send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Bundlers put a content hash in the names of files that never change (app.3f9a1c2b.js,
 * assets/index-BxQ2kL9a.css). Those can be cached for a year; everything else is revalidated.
 */
export function cacheControl(key: string): string {
  const name = path.posix.basename(key);
  const hash = /[.-]([A-Za-z0-9_]{8,})\.[a-z0-9]+$/i.exec(name)?.[1];
  // A real hash mixes in digits; "my-component.css" doesn't.
  const hashed = hash !== undefined && /\d/.test(hash) && !name.endsWith(".html");
  return hashed ?"public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate";
}

export interface SiteFile {
  key: string;
  file: string;
  md5: string;
  size: number;
}

/** Every file under `dir`, keyed by its POSIX path relative to `dir`. Dotfiles are skipped. */
export function collectSite(dir: string): SiteFile[] {
  const out: SiteFile[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const body = fs.readFileSync(full);
        out.push({ key: path.relative(dir, full).split(path.sep).join("/"), file: full, md5: createHash("md5").update(body).digest("hex"), size: body.length });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export interface SyncResult {
  uploaded: string[];
  unchanged: number;
  /** Files in the bucket that aren't in this build. Kept, so open tabs can still load old chunks. */
  stale: string[];
}

/** Uploads new and changed files. Single-part uploads have the MD5 as ETag, which is what we compare. */
export async function syncSite(bucket: string, region: string, files: SiteFile[]): Promise<SyncResult> {
  const s3 = aws.s3(region);
  const remote = new Map<string, string>();
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) remote.set(o.Key, (o.ETag ?? "").replace(/"/g, ""));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const changed = files.filter((f) => remote.get(f.key) !== f.md5);
  const queue = [...changed];
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        await s3.send(
          new PutObjectCommand({ Bucket: bucket, Key: f.key, Body: fs.readFileSync(f.file), ContentType: contentType(f.key), CacheControl: cacheControl(f.key) }),
        );
      }
    }),
  );
  const local = new Set(files.map((f) => f.key));
  return { uploaded: changed.map((f) => f.key), unchanged: files.length - changed.length, stale: [...remote.keys()].filter((k) => !local.has(k)) };
}

export async function deleteSiteBucket(bucket: string, region: string): Promise<boolean> {
  const s3 = aws.s3(region);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
  for (;;) {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (!keys.length) break;
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  return true;
}
