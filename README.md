# Hatch

Deploy a Node web server to [AWS Lambda Web Functions](https://aws.amazon.com/blogs/aws/announcing-aws-lambda-web-functions-for-fast-consistent-web-app-performance-anywhere/) in your own AWS account with one command. Hatch handles the parts around the deploy: bundling, the execution role, key-value storage, secrets, multi-region endpoints, canary releases, rollback and logs from every region.

```bash
npm create hatch@latest my-app      # or: --template express
cd my-app && npm install
npx hatch dev                       # http://127.0.0.1:3000, reloads on save
npx hatch deploy                    # https://<id>.lambda-web.us-east-1.on.aws
```

> Name check: `hatch` is already taken on npm and Python's Hatch uses the name. Rename before publishing.

## Your code

```ts
import { Hono } from "hono";
import { kv, log, secret, region, serve } from "hatch";

const app = new Hono();
const cache = kv<User>("users");            // DynamoDB table, created on deploy
const stripe = new Stripe(secret("STRIPE_KEY")); // from SSM, set with `hatch secrets set`

app.get("/user/:id", async (c) => {
  const user = await cache.get(c.req.param("id"));
  log.info("user lookup", { hit: Boolean(user), region: region.current });
  return c.json(user ?? null);
});

serve(app); // binds AWS_LAMBDA_HTTP_ENDPOINT in AWS, PORT locally
```

- **`serve(app)`** takes any fetch-style app (Hono) or Node handler (Express, Connect). It binds where Lambda says, streams responses (SSE, LLM tokens), logs one JSON line per request, and shuts down cleanly on SIGTERM. For an existing Express app, replace `app.listen(3000)` with `serve(app)`.
- **`kv(name)`** is a key-value store with `get`, `set(key, value, { ttl })` and `delete`. Deploy creates a DynamoDB table per stage. With more than one region it becomes a global table. Under `hatch dev` it's a file in `.hatch/dev/`.
- **`secret(NAME)`** reads a secret. Deploy copies the secrets your code references from SSM Parameter Store into the revision's encrypted environment. Under `hatch dev` they come from `.env`.
- **`log.info/warn/error/debug(msg, fields)`** writes structured JSON with the request id, region, stage and deploy id attached automatically. Keys like `password`, `token` and `authorization` are redacted.

Hatch finds `kv("…")` and `secret("…")` calls by parsing your source at deploy time, so names must be string literals.

## Config (optional)

```ts
// hatch.config.ts
import { defineConfig } from "hatch";

export default defineConfig({
  name: "my-app",
  regions: ["us-east-1", "eu-west-1", "ap-northeast-1"], // first = home region
  timeoutSeconds: 30,
  maxConcurrency: 64,
  env: { LOG_FORMAT: "json" },
  stages: {
    prod: { canary: 10 },
  },
});
```

One region gives a `HomeRegion` endpoint. Several give a `MultiRegion` endpoint with one URL, latency-based routing and global kv tables. Without a config file, Hatch uses `package.json`'s name, finds `src/index.ts` (or `server.ts`, `index.js`, …), and deploys to `AWS_REGION` or `us-east-1`.

## Commands

| Command | What it does |
| --- | --- |
| `hatch dev [--port 3000]` | Local server with rebuild on save, local kv and `.env` secrets |
| `hatch build` | Bundle into `.hatch/build/` and list the resources found |
| `hatch deploy [--stage dev] [--canary 10] [--regions a,b]` | Build, provision and deploy, then print the URL |
| `hatch status` | URL, traffic split, revisions and regional endpoints |
| `hatch logs [--status 5xx] [--request id] [--path /x] [--level error] [--since 1h]` | Live tail across all regions, or history with `--since` |
| `hatch promote` | Move the canary to 100% |
| `hatch rollback [--to rev]` | End a canary, or go back to the previous revision |
| `hatch secrets set NAME [value]` / `list` / `rm NAME` | Manage secrets per stage. A value from stdin stays out of shell history |
| `hatch doctor` | Find code that breaks on Lambda: `app.listen`, module-level Maps, `setInterval`, local disk writes, WebSockets, native modules |
| `hatch destroy [--purge-data] [--yes]` | Delete the function, endpoint and role. kv data is kept unless `--purge-data` |

Every command takes `--stage` (default `dev`). Stages are separate functions: `my-app-dev`, `my-app-prod`, `my-app-pr-42`.

## What a deploy creates

In the home region, all tagged `hatch:app` and `hatch:stage`:

1. **Artifact bucket** `hatch-artifacts-<account>-<region>`: private, and old zips expire after 30 days. Zips are content-addressed, so an unchanged build isn't uploaded again.
2. **DynamoDB table** `<app>-<stage>-kv-<name>` for each `kv()`: on-demand billing, TTL on, and replicas in your other regions.
3. **IAM role** `hatch-<app>-<stage>`: can write its own log group and read/write only its own kv tables.
4. **Web function** `<app>-<stage>` with endpoint `main` on runtime `nodejs24.x`. Each deploy is a new revision, and Hatch sets the traffic weights explicitly (`autoDeploymentMode: Disabled`), so canaries and rollbacks are always deliberate.

## Canary releases

With `canary: 10` on a stage (or `--canary 10`), a deploy sends 10% of traffic to the new revision and leaves 90% on the current one. Then:

```bash
hatch status --stage prod                   # see the split
hatch logs --stage prod --status 5xx        # watch errors
hatch promote --stage prod                  # 100% to the new revision
hatch rollback --stage prod                 # or back to the stable revision
```

## CI: previews per PR

`create-hatch` adds `.github/workflows/hatch.yml`:

- Each PR deploys to stage `pr-<number>` and gets the URL as a comment.
- Closing the PR destroys that stage.
- Pushing to `main` deploys `prod`.

It needs an IAM role GitHub can assume through OIDC, stored as the `AWS_DEPLOY_ROLE_ARN` secret. It runs on an Arm64 runner, which matches the Lambda runtime.

## Repo layout

```
packages/hatch          CLI (`hatch`) + runtime SDK (`import … from "hatch"`)
  src/runtime/          serve, log, kv, secret, region, defineConfig
  src/build/            project loading, esbuild bundling, resource analysis, doctor
  src/aws/              S3, IAM, DynamoDB, SSM, CloudWatch Logs, Lambda Web
  src/deploy.ts         deploy / status / promote / rollback / destroy
  src/cli/              commands
packages/create-hatch   `npm create hatch` scaffolder + Hono/Express templates
examples/hono-app       generated from the Hono template
```

```bash
pnpm install
pnpm build
pnpm test        # runtime, bundling (runs the real artifact), mocked-AWS deploy flows, scaffolder
```

## Status and known gaps

Everything above runs locally and is covered by tests against mocked AWS APIs. **It hasn't yet been deployed to a real AWS account.** These are assumptions to verify on the first real deploy:

- **Execution role trust principal.** The docs don't name one for Web Functions. Hatch uses `lambda.amazonaws.com`; override with `roleTrustPrincipal` in the config if AWS rejects it.
- **Artifact format.** The API takes an S3 object. Hatch uploads a zip with `index.js`, `package.json` (`"start": "node index.js"`) and the bundle, which covers both likely start conventions.
- **Log group.** Hatch assumes the documented default `/aws/lambda/web/<function>`, with the same name in each region of a multi-region endpoint.

Not built yet (see the plan doc): static assets on S3 and CloudFront, custom domains, the Next.js adapter, `queue()` / `cron()` / `sandbox()`, OpenTelemetry tracing, alarm-driven automatic rollback, and the hosted console.
