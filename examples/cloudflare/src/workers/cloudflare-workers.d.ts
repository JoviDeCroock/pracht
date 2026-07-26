// Minimal ambient types for the `cloudflare:workers` runtime module so the
// example typechecks without pulling in @cloudflare/workers-types. The real
// module only exists inside workerd; `pracht build` stubs it during SSG
// prerendering.
declare module "cloudflare:workers" {
  export class WorkerEntrypoint {
    fetch?(request: Request): Response | Promise<Response>;
  }
  export class DurableObject<TEnv = unknown> {
    constructor(ctx: DurableObjectState, env: TEnv);
    protected ctx: DurableObjectState;
    protected env: TEnv;
    fetch?(request: Request): Response | Promise<Response>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void;
  }
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectState {
  /**
   * Hibernation-aware accept: the runtime holds the socket open while the
   * object is evicted from memory, and re-instantiates it to deliver events.
   */
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

/**
 * workerd's WebSocket carries server-side methods the DOM lib does not
 * declare (the DOM type only models the client end of a connection).
 */
interface WebSocket {
  accept(): void;
}

/** `new WebSocketPair()` yields `{ 0: client, 1: server }`. */
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

/**
 * workerd extends `ResponseInit` with `webSocket` to return the server end of
 * a handshake. It is deliberately absent from the fetch standard, which is
 * exactly why a 101 response cannot be copied — see `isProtocolSwitchResponse`
 * in @pracht/core/server.
 */
interface ResponseInit {
  webSocket?: WebSocket | null;
}
