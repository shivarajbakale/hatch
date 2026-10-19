import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Static facts about where this process runs. Set by `hatch deploy`, or by `hatch dev` locally. */
export const runtimeInfo = {
  get app(): string | undefined {
    return process.env.HATCH_APP;
  },
  get stage(): string | undefined {
    return process.env.HATCH_STAGE;
  },
  get deployId(): string | undefined {
    return process.env.HATCH_DEPLOY_ID;
  },
  get isDev(): boolean {
    return process.env.HATCH_DEV === "1";
  },
};

export const region = {
  /** The AWS Region serving this request, or "local" under `hatch dev`. */
  get current(): string {
    return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "local";
  },
};
