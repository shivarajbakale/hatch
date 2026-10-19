import { createHash } from "node:crypto";
import {
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  RequestCertificateCommand,
  type CertificateStatus,
} from "@aws-sdk/client-acm";
import { ChangeResourceRecordSetsCommand, ListHostedZonesCommand, ListResourceRecordSetsCommand, type ResourceRecordSet } from "@aws-sdk/client-route-53";
import { HatchError } from "../build/project.js";
import { aws, waitFor } from "./clients.js";

/** The fixed hosted zone id AWS uses for every CloudFront alias record. */
export const CLOUDFRONT_ZONE_ID = "Z2FDTNDATAQYW2";

export interface DnsRecord {
  name: string;
  type: string;
  value: string;
}

export interface Certificate {
  arn: string;
  status: CertificateStatus | string;
  /** The CNAME that proves you own the domain. ACM issues the certificate once it resolves. */
  validation?: DnsRecord;
}

const trimDot = (s: string) => s.replace(/\.$/, "").toLowerCase();

async function findCertificate(domain: string): Promise<string | undefined> {
  let nextToken: string | undefined;
  const found: { arn: string; status?: string }[] = [];
  do {
    const page = await aws.acm().send(new ListCertificatesCommand({ CertificateStatuses: ["ISSUED", "PENDING_VALIDATION"], NextToken: nextToken }));
    for (const c of page.CertificateSummaryList ?? []) if (c.DomainName === domain && c.CertificateArn) found.push({ arn: c.CertificateArn, status: c.Status });
    nextToken = page.NextToken;
  } while (nextToken);
  return (found.find((c) => c.status === "ISSUED") ?? found[0])?.arn;
}

export async function describeCertificate(arn: string): Promise<Certificate> {
  const out = await aws.acm().send(new DescribeCertificateCommand({ CertificateArn: arn }));
  const rr = out.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord;
  return {
    arn,
    status: out.Certificate?.Status ?? "PENDING_VALIDATION",
    validation: rr?.Name && rr.Type && rr.Value ? { name: trimDot(rr.Name), type: rr.Type, value: trimDot(rr.Value) } : undefined,
  };
}

/**
 * Reuses an issued or pending certificate for exactly this domain, or requests one.
 * CloudFront only accepts certificates from us-east-1, which is where the ACM client points.
 */
export async function ensureCertificate(domain: string, tags: Record<string, string>): Promise<Certificate> {
  let arn = await findCertificate(domain);
  if (!arn) {
    const out = await aws.acm().send(
      new RequestCertificateCommand({
        DomainName: domain,
        ValidationMethod: "DNS",
        // Same token for the same domain, so a retried deploy doesn't request a second certificate.
        IdempotencyToken: createHash("sha256").update(domain).digest("hex").slice(0, 32),
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
    arn = out.CertificateArn;
    if (!arn) throw new Error("RequestCertificate returned no ARN");
  }
  // ACM fills in the validation record a few seconds after the request.
  return waitFor("certificate validation record", async () => {
    const cert = await describeCertificate(arn);
    return cert.status === "ISSUED" || cert.validation ? cert : undefined;
  }, 60_000);
}

export async function waitForCertificate(arn: string, timeoutMs: number): Promise<boolean> {
  try {
    await waitFor("certificate", async () => {
      const cert = await describeCertificate(arn);
      if (cert.status === "FAILED" || cert.status === "VALIDATION_TIMED_OUT") throw new HatchError(`The certificate for this domain is ${cert.status}. Delete it in ACM (us-east-1) and deploy again.`);
      return cert.status === "ISSUED" ? true : undefined;
    }, timeoutMs);
    return true;
  } catch (err) {
    if (err instanceof HatchError) throw err;
    return false;
  }
}

/** The certificate hatch created for this domain and stage, if any. Others are never touched. */
export async function findOwnCertificate(domain: string, tags: Record<string, string>): Promise<string | undefined> {
  const arn = await findCertificate(domain);
  if (!arn) return undefined;
  const out = await aws.acm().send(new ListTagsForCertificateCommand({ CertificateArn: arn }));
  const have = new Map((out.Tags ?? []).map((t) => [t.Key, t.Value]));
  return Object.entries(tags).every(([k, v]) => have.get(k) === v) ? arn : undefined;
}

export async function deleteCertificate(arn: string): Promise<void> {
  await aws.acm().send(new DeleteCertificateCommand({ CertificateArn: arn }));
}

/** The most specific public Route 53 zone that contains `domain`, if the account has one. */
export async function findHostedZone(domain: string): Promise<{ id: string; name: string } | undefined> {
  let best: { id: string; name: string } | undefined;
  let marker: string | undefined;
  do {
    const page = await aws.route53().send(new ListHostedZonesCommand({ Marker: marker }));
    for (const z of page.HostedZones ?? []) {
      if (z.Config?.PrivateZone || !z.Id || !z.Name) continue;
      const name = trimDot(z.Name);
      if ((domain === name || domain.endsWith(`.${name}`)) && name.length > (best?.name.length ?? 0)) {
        best = { id: z.Id.replace("/hostedzone/", ""), name };
      }
    }
    marker = page.IsTruncated ? page.NextMarker : undefined;
  } while (marker);
  return best;
}

export async function upsertValidationRecord(zoneId: string, record: DnsRecord): Promise<void> {
  await aws.route53().send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Comment: "hatch: ACM certificate validation",
        Changes: [{ Action: "UPSERT", ResourceRecordSet: { Name: record.name, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: record.value }] } }],
      },
    }),
  );
}

async function recordsAt(zoneId: string, domain: string): Promise<ResourceRecordSet[]> {
  const out = await aws.route53().send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: domain, MaxItems: 20 }));
  return (out.ResourceRecordSets ?? []).filter((r) => trimDot(r.Name ?? "") === domain);
}

const pointsAt = (r: ResourceRecordSet, target: string) => trimDot(r.AliasTarget?.DNSName ?? "") === trimDot(target);

/**
 * Points `domain` at the distribution with A and AAAA alias records. Refuses to replace a record
 * that points somewhere else: that's someone's live site, and moving it is the user's call.
 */
export async function upsertAliasRecords(zoneId: string, domain: string, distributionDomain: string): Promise<void> {
  const existing = await recordsAt(zoneId, domain);
  const conflict = existing.find((r) => ["A", "AAAA", "CNAME"].includes(r.Type ?? "") && !pointsAt(r, distributionDomain));
  if (conflict) {
    throw new HatchError(
      `${domain} already has a ${conflict.Type} record that points elsewhere. Hatch won't overwrite it.\n` +
        `Delete that record in Route 53 (or pick another domain), then deploy again.`,
    );
  }
  const alias = (Type: "A" | "AAAA") => ({
    Action: "UPSERT" as const,
    ResourceRecordSet: { Name: domain, Type, AliasTarget: { HostedZoneId: CLOUDFRONT_ZONE_ID, DNSName: distributionDomain, EvaluateTargetHealth: false } },
  });
  await aws.route53().send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: { Comment: "hatch: custom domain", Changes: [alias("A"), alias("AAAA")] } }));
}

/** Removes only the alias records that point at this distribution. */
export async function deleteAliasRecords(zoneId: string, domain: string, distributionDomain: string): Promise<number> {
  const ours = (await recordsAt(zoneId, domain)).filter((r) => (r.Type === "A" || r.Type === "AAAA") && pointsAt(r, distributionDomain));
  if (!ours.length) return 0;
  await aws.route53().send(
    new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: { Changes: ours.map((r) => ({ Action: "DELETE" as const, ResourceRecordSet: r })) } }),
  );
  return ours.length;
}
