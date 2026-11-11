import type { IncomingMessage } from "node:http";

/** Recent request failures, scoped to one development server. */
export const DEV_ERROR_LIMIT = 50;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_STACK_LENGTH = 8192;

export interface DevRequestError {
  at: number;
  path: string;
  phase: string | null;
  routeId: string | null;
  file: string | null;
  message: string;
  stack: string | null;
}

/** Unlike the devtools graph, raw error stacks are only served over loopback. */
export function isLocalDiagnosticsRequest(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") {
    return false;
  }
  try {
    const host = new URL(`http://${request.headers.host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) return false;
    if (host.username || host.password || host.pathname !== "/" || host.search || host.hash)
      return false;
    if (request.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    const expected = new URL(origin);
    const protocol = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted
      ? "https:"
      : "http:";
    return (
      expected.protocol === protocol && expected.host === host.host && expected.origin === origin
    );
  } catch {
    return false;
  }
}

export function createDevErrorBuffer() {
  const events: DevRequestError[] = [];
  let recorded = 0;
  return {
    record(event: Omit<DevRequestError, "at">): void {
      recorded += 1;
      events.push({
        at: Date.now(),
        path: event.path.slice(0, 1024),
        phase: event.phase?.slice(0, 128) ?? null,
        routeId: event.routeId?.slice(0, 1024) ?? null,
        file: event.file?.slice(0, 1024) ?? null,
        message: event.message.slice(0, MAX_MESSAGE_LENGTH),
        stack: event.stack?.slice(0, MAX_STACK_LENGTH) ?? null,
      });
      if (events.length > DEV_ERROR_LIMIT) events.shift();
    },
    snapshot() {
      return { limit: DEV_ERROR_LIMIT, recorded, events: [...events].reverse() };
    },
  };
}
