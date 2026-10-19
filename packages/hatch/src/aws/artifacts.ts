import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { aws, isNotFound } from "./clients.js";

export function artifactBucketName(account: string, region: string): string {
  return `hatch-artifacts-${account}-${region}`;
}

/** One private bucket per account and region holds deploy zips. Old zips expire after 30 days. */
export async function ensureArtifactBucket(account: string, region: string): Promise<string> {
  const bucket = artifactBucketName(account, region);
  const s3 = aws.s3(region);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: account }));
    return bucket;
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
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: [{ ID: "expire-old-artifacts", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 30 } }] },
    }),
  );
  return bucket;
}

/** Uploads the zip under its content hash. Skips the upload when that exact zip is already there. */
export async function uploadArtifact(region: string, bucket: string, key: string, body: Uint8Array): Promise<void> {
  const s3 = aws.s3(region);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/zip" }));
}
