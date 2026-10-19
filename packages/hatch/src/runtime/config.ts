export interface StageConfig {
  /** Percent of traffic the new revision gets on deploy. The rest stays on the current one until `hatch promote`. */
  canary?: number;
  /** Overrides the top-level regions for this stage. */
  regions?: string[];
  env?: Record<string, string>;
  /**
   * Custom domain for this stage, like "app.example.com". Hatch requests the certificate and, when
   * the domain's zone is in Route 53, writes the DNS records. Otherwise it prints them for you.
   */
  domain?: string;
}

export interface StaticConfig {
  /** Folder with the built frontend, relative to the project root. Uploaded to S3 on every deploy. */
  dir: string;
  /** Command that builds `dir`, run before upload. For example "npm run build --prefix web". */
  build?: string;
  /** Single-page app: paths without a file extension serve index.html. Default true. */
  spa?: boolean;
}

export interface HatchConfig {
  /** App name. Lowercase letters, digits and dashes. Defaults to package.json "name". */
  name?: string;
  /** Server entry file. Detected from common paths when omitted. */
  entry?: string;
  /**
   * Regions to serve from. The first is the home region (artifacts, IAM, secrets live there).
   * More than one gives a MultiRegion endpoint with latency-based routing.
   */
  regions?: string[];
  /** Request timeout in seconds, 3–900. Lambda's default is 30. */
  timeoutSeconds?: number;
  /** Concurrent requests per execution environment, 1–128. Lambda's default is 64. */
  maxConcurrency?: number;
  /** Plain (non-secret) environment variables for every stage. */
  env?: Record<string, string>;
  stages?: Record<string, StageConfig>;
  /**
   * Frontend files served from S3 through CloudFront on the same domain as the server.
   * Requests matching `routes` go to the server; everything else is served from `dir`.
   */
  static?: StaticConfig;
  /**
   * CloudFront path patterns sent to the server when `static` is set. Default ["/api/*"].
   * Without `static`, every path goes to the server.
   */
  routes?: string[];
  /**
   * Service principal in the execution role's trust policy. The launch docs don't name one for
   * Web Functions yet; override if AWS rejects the default.
   */
  roleTrustPrincipal?: string;
}

/** Typed helper for hatch.config.ts. */
export function defineConfig(config: HatchConfig): HatchConfig {
  return config;
}

/** Regions where Lambda Web Functions launched. */
export const SUPPORTED_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "ap-northeast-1", "eu-west-1"] as const;
