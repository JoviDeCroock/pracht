declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export const exports: Record<string, unknown>;
  export const cache: { purge(): never };
  export const tracing: {
    enterSpan(name: string, callback: (...args: unknown[]) => unknown): never;
  };
  export class RpcStub {
    constructor(value: unknown);
  }
  export class RpcTarget {}
  export class WorkerEntrypoint {
    fetch?(request: Request): Response | Promise<Response>;
  }
  export class DurableObject<TEnv = unknown> {
    constructor(ctx: unknown, env: TEnv);
    protected ctx: unknown;
    protected env: TEnv;
    fetch?(request: Request): Response | Promise<Response>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void;
  }
  export class WorkflowEntrypoint<TEnv = unknown> {
    protected ctx: unknown;
    protected env: TEnv;
  }
  export function waitUntil(promise: Promise<unknown>): void;
  export function withEnv(newEnv: unknown, callback: () => unknown): unknown;
  export function withExports(newExports: unknown, callback: () => unknown): unknown;
  export function withEnvAndExports(
    newEnv: unknown,
    newExports: unknown,
    callback: () => unknown,
  ): unknown;
}

declare module "cloudflare:future-runtime" {
  export const runtimeMarker: unknown;
}

declare module "cloudflare:email" {
  export class EmailMessage {}
}

declare module "cloudflare:workflows" {
  export class WorkflowEntrypoint {}
}
