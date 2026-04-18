import type { IncomingMessage, ServerResponse } from "node:http";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

export async function createWebRequest(
  req: IncomingMessage,
  options: { trustProxy: boolean; canonicalOrigin?: string },
): Promise<Request> {
  const baseUrl = resolveRequestBase(req, options);
  const url = new URL(req.url ?? "/", baseUrl);
  const method = req.method ?? "GET";
  const headers = createHeaders(req.headers);
  const init: RequestInit = {
    headers,
    method,
  };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const body = await readRequestBody(req);
    if (body.byteLength > 0) {
      const exactBody = new Uint8Array(body.byteLength);
      exactBody.set(body);
      init.body = exactBody.buffer;
    }
  }

  return new Request(url, init);
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

/**
 * Derive the request base URL from the incoming message.
 *
 * When `canonicalOrigin` is provided, it wins and request URL construction no
 * longer depends on `Host` / forwarded host headers. This is the safest option
 * for apps that generate absolute URLs from `request.url`.
 *
 * Otherwise, when `trustProxy` is false (default), the protocol is inferred
 * from the socket's TLS state and the host from the HTTP `Host` header.
 * Forwarded headers are ignored entirely.
 *
 * When `trustProxy` is true, the following precedence applies for the derived
 * host/protocol:
 *   1. RFC 7239 `Forwarded` header (`proto=` / `host=` directives)
 *   2. `X-Forwarded-Proto` / `X-Forwarded-Host`
 *   3. Socket-derived values (fallback)
 */
function resolveRequestBase(
  req: IncomingMessage,
  options: { trustProxy: boolean; canonicalOrigin?: string },
): URL {
  if (options.canonicalOrigin) {
    return new URL(options.canonicalOrigin);
  }

  const { protocol, host } = resolveOrigin(req, options.trustProxy);
  return new URL(`${protocol}://${host}`);
}

function resolveOrigin(
  req: IncomingMessage,
  trustProxy: boolean,
): { protocol: string; host: string } {
  const socketProtocol =
    "encrypted" in req.socket && (req.socket as { encrypted?: boolean }).encrypted
      ? "https"
      : "http";
  const socketHost = getFirstHeaderValue(req.headers.host) ?? "localhost";

  if (!trustProxy) {
    return { protocol: socketProtocol, host: socketHost };
  }

  const forwarded = getFirstHeaderValue(req.headers.forwarded);
  if (forwarded) {
    const parsed = parseForwardedHeader(forwarded);
    return {
      protocol:
        parsed.proto ?? getFirstHeaderValue(req.headers["x-forwarded-proto"]) ?? socketProtocol,
      host: parsed.host ?? getFirstHeaderValue(req.headers["x-forwarded-host"]) ?? socketHost,
    };
  }

  const proto = getFirstHeaderValue(req.headers["x-forwarded-proto"]) ?? socketProtocol;
  const host = getFirstHeaderValue(req.headers["x-forwarded-host"]) ?? socketHost;
  return { protocol: proto, host };
}

/**
 * Parse the first element of an RFC 7239 `Forwarded` header, extracting
 * `proto` and `host` directives.  Returns `undefined` for directives that
 * are not present.
 */
function parseForwardedHeader(value: string): { proto?: string; host?: string } {
  const first = value.split(",")[0];
  const result: { proto?: string; host?: string } = {};

  for (const part of first.split(";")) {
    const [key, val] = part.trim().split("=");
    if (!key || !val) continue;
    const k = key.toLowerCase();
    const v = val.replace(/^"|"$/g, "");
    if (k === "proto") result.proto = v;
    else if (k === "host") result.host = v;
  }

  return result;
}

function createHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(key, entry);
      }

      continue;
    }

    result.set(key, value);
  }

  return result;
}

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalSize += buf.byteLength;
    if (totalSize > MAX_BODY_SIZE) {
      req.destroy();
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
