export interface StageConfig {
  /** Percent of traffic the new revision gets on deploy. The rest stays on the current one until `hatch promote`. */
  canary?: number;
  /** Overrides the top-level regions for this stage. */
  regions?: string[];
  env?: Record<string, string>;
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
