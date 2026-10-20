import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { applyDefaultSecurityHeaders, normalizeResponseHeaders } from "@pracht/core/server";

import {
  COMPRESSION_MIN_SIZE,
  type ContentEncoding,
  createCompressedStream,
  encodeEtagForEncoding,
  isCompressibleContentType,
  isNotModifiedRequest,
  isTransformableResponse,
  matchesIfMatch,
  mergeVaryOnNodeResponse,
  negotiateEncoding,
  protectIdentityEtag,
  type CompressionState,
} from "./node-compress.ts";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
export const DEFAULT_MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

/**
 * Node error codes that mean "the client went away mid-response", not "the
 * server broke". `http.createServer()` does not await the handler's promise,
 * so letting one of these reject would surface as an unhandled rejection and
 * (on Node >= 15) terminate the process — a client pressing Escape would take
 * the server down with it.
 */
const CLIENT_DISCONNECT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/**
 * Whether `error` is a client disconnect rather than a server-side failure.
 *
 * Walks the `cause` chain because a transport wraps the underlying failure
 * (undici reports a peer reset as `TypeError: terminated` with
 * `cause.code === "ECONNRESET"`). The walk is iterative and cycle-guarded: a
 * self-referential or mutually-referential `cause` is legal JavaScript, and
 * recursing on it would throw `RangeError` from inside the handler's own
 * catch block — turning the crash this function exists to prevent back into an
 * unhandled rejection.
 */
export function isClientDisconnectError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CLIENT_DISCONNECT_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Pipe `source` into `res`, resolving when the client goes away and rejecting
 * only when the *source* fails.
 *
 * Deliberately not `stream.pipeline()`. Pipeline destroys every stream it was
 * given on any failure — including calling `destroy(err)` on the source when
 * the destination dies — so afterwards `req.aborted`, `req.destroyed`,
 * `res.destroyed`, and "the source emitted an error" are all true whether the
 * client hung up or an upstream `fetch()` body blew up. Nothing is left to
 * classify on. The error code cannot stand in either: undici surfaces a TCP
 * reset from a proxied backend as `TypeError: terminated` with
 * `cause.code === "ECONNRESET"`, so a backend outage would be filed as a
 * client disconnect and vanish from the logs.
 *
 * Owning the plumbing keeps the two sides distinguishable, and leaves `res`
 * intact after a source failure so the caller can still answer `500` when
 * nothing has been written yet.
 */
export function pipeToResponse(source: NodeJS.ReadableStream, res: ServerResponse): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    let settled = false;

    const cleanup = (): void => {
      // `onSourceError` is deliberately NOT removed. `Readable.prototype.pipe`
      // attaches `'error'` handlers to the destination, never to the source, so
      // this is the source's only listener — and `destroy()` reports
      // asynchronously, so a source whose teardown fails (a `close()` raising
      // EIO on overlayfs/NFS, say) would emit `'error'` afterwards with nothing
      // listening. EventEmitter rethrows that, terminating the process: exactly
      // the failure this function exists to prevent. It is inert once settled.
      res.off("error", onResponseError);
      res.off("close", onResponseClose);
      res.off("finish", onFinish);
    };

    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWrite();
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWrite(error);
    };

    /** The client is gone: stop reading so the source cannot leak. */
    const abandonSource = (): void => {
      source.unpipe?.(res);
      (source as { destroy?: () => void }).destroy?.();
    };

    function onSourceError(error: unknown): void {
      // A server-side failure. `res` is deliberately left alone so the caller
      // can still turn this into a response.
      source.unpipe?.(res);
      fail(error);
    }

    function onResponseError(error: unknown): void {
      abandonSource();
      // Not every response error is the client leaving: a `content-length` that
      // disagrees with the body raises `ERR_HTTP_CONTENT_LENGTH_MISMATCH` on
      // `res`, and swallowing it would hide a server bug the same way keying on
      // the error code hid an upstream reset.
      if (isClientDisconnectError(error)) succeed();
      else fail(error);
    }

    function onResponseClose(): void {
      // Closed before the body finished means the client hung up.
      if (!res.writableFinished) abandonSource();
      succeed();
    }

    function onFinish(): void {
      succeed();
    }

    source.on("error", onSourceError);
    res.on("error", onResponseError);
    res.on("close", onResponseClose);
    res.on("finish", onFinish);

    // The client may already have hung up while the loader ran, the component
    // rendered, or the file was stat()ed — the whole window that matters. `res`
    // is then destroyed and its `'close'` has already fired, so none of the
    // listeners above will ever run and `res.write()` on a destroyed
    // `OutgoingMessage` emits nothing. Without this check the promise never
    // settles and the body is never cancelled: an undici response holds its
    // pooled connection, an fs stream holds its descriptor, and both accumulate
    // one per aborted request.
    if (res.destroyed || res.writableEnded) {
      abandonSource();
      succeed();
      return;
    }

    source.pipe(res);
  });
}

/**
 * A signal that fires when the client hangs up before the response finished.
 *
 * Node reports a completed exchange and an abandoned one the same way — a
 * `close` on both the request and the response — so the response's own state
 * is the discriminator: `close` while `res.writableFinished` is still `false`
 * means the socket went away while the app was still working. The request's
 * `close` only counts while its body is incomplete: Node also emits it as soon
 * as a fully read upload is consumed, while the app is still answering.
 *
 * Without this the platform `Request` carries a signal that never aborts, and
 * `defineApp({ loaderTimeoutMs })` degrades to a plain timeout on the one
 * adapter most likely to be running long loaders.
 */
export function createClientDisconnectSignal(
  req: IncomingMessage,
  res: ServerResponse,
): AbortSignal | undefined {
  // Connect-style middleware stacks (Vite dev) can hand over non-stream stand-ins.
  if (typeof req.on !== "function" || typeof res.on !== "function") return undefined;
  const controller = new AbortController();
  abortOnEnd.set(res, () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("The server is shutting down.", "AbortError"));
    }
  });
  const abortIfUnfinished = (): void => {
    if (res.writableFinished || controller.signal.aborted) return;
    controller.abort(new DOMException("The client closed the request.", "AbortError"));
  };
  req.on("close", () => {
    if (!req.complete) abortIfUnfinished();
  });
  res.on("close", abortIfUnfinished);
  return controller.signal;
}

/** Options for turning a `node:http` request into a Web `Request`. */
export interface NodeBridgeOptions {
  /** Largest request body read, in bytes (default 1 MiB). A larger one is answered with 413. */
  maxBodySize?: number;
  /**
   * Build `request.url` from `Forwarded` / `X-Forwarded-*` headers (default
   * `false`). Enable only behind a trusted reverse proxy.
   */
  trustProxy?: boolean;
  /** Public origin for `request.url`; wins over `Host` and forwarded headers. */
  canonicalOrigin?: string;
  /**
   * Deploy base an upstream middleware already removed from `req.url` (Vite's
   * dev server does). It is put back so `request.url` is the URL the visitor
   * asked for.
   */
  base?: string;
}

/**
 * Turn a `node:http` request into a Web `Request`, or into the `Response` that
 * answers it: 413 for a body over `maxBodySize` (checked against a declared
 * `Content-Length` before any byte is read) and 400 for anything that does not
 * form a `Request`: a request target or `Host` that is no URL, a `Host` with
 * userinfo or URL delimiters in it, a target with credentials, or a method a
 * `Request` cannot carry. Both carry the default security headers.
 *
 * `request.signal` aborts when the client disconnects before `res` finished.
 * It is the client's signal only; the framework adds its own deadlines.
 */
export async function createWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: NodeBridgeOptions = {},
): Promise<Request | Response> {
  // Created before the body is read: a client that hangs up mid-upload has
  // to abort the work its request already started.
  const signal = createClientDisconnectSignal(req, res);
  const method = req.method ?? "GET";

  // A request the client malformed is answered here, before any body is read,
  // and never reaches the server's error log.
  let url: URL;
  const init: RequestInit = { headers: createHeaders(req.headers), method, signal };
  try {
    url = new URL(
      restoreBase(normalizeRequestTarget(req.url, options), options.base),
      resolveRequestBase(req, options),
    );
    // `new Request()` refuses a URL with credentials (`GET http://u:p@x/`).
    if (url.username || url.password) throw new TypeError("Credentials in the request target");
  } catch {
    return createBridgeErrorResponse(400, "Bad Request");
  }

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const body = await readRequestBody(req, options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE);
    // The rest of the body is never read, so the connection cannot be reused.
    if (body === null) return createBridgeErrorResponse(413, "Payload Too Large", true);
    if (body.byteLength > 0) init.body = body;
  }

  try {
    return new Request(url, init);
  } catch {
    return createBridgeErrorResponse(400, "Bad Request");
  }
}

function createBridgeErrorResponse(status: number, body: string, close = false): Response {
  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    }),
  );
  if (close) headers.set("connection", "close");
  return new Response(body, { headers, status });
}

function restoreBase(target: string, base: string | undefined): string {
  if (!base || base === "/" || !target.startsWith("/")) return target;
  return `${base.endsWith("/") ? base : `${base}/`}${target.slice(1)}`;
}

function normalizeRequestTarget(
  rawTarget: string | undefined,
  options: { canonicalOrigin?: string },
): string {
  const target = rawTarget ?? "/";

  if (!options.canonicalOrigin) {
    return target;
  }

  if (target.startsWith("//")) {
    const networkPathUrl = new URL(`https:${target}`);
    return `${networkPathUrl.pathname}${networkPathUrl.search}${networkPathUrl.hash}`;
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(target)) {
    const absoluteUrl = new URL(target);
    return `${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`;
  }

  return target;
}

export async function writeWebResponse(
  res: ServerResponse,
  response: Response,
  compression?: CompressionState,
): Promise<void> {
  response = normalizeResponseHeaders(response);
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  writeNodeResponseHeaders(res, response.headers);

  let encoding: ContentEncoding | null = null;
  const sourceEtag = getNodeHeaderValue(res, "etag");
  const sourceEncoding = response.headers.get("content-encoding");
  if (
    compression &&
    sourceEtag &&
    (!sourceEncoding || sourceEncoding.toLowerCase() === "identity")
  ) {
    res.setHeader("etag", protectIdentityEtag(sourceEtag));
  }
  const compressibleContentType = isCompressibleContentType(response.headers.get("content-type"));
  if (compression && (compressibleContentType || response.status === 304)) {
    // An application-generated 304 may omit Content-Type, but it still needs
    // the Vary field the adapter adds to the corresponding 200 response.
    mergeVaryOnNodeResponse(res);
  }
  if (
    compression &&
    !compression.request.headers.has("range") &&
    compressibleContentType &&
    isTransformableResponse(response.status, response.headers)
  ) {
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    const belowThreshold = !Number.isNaN(contentLength) && contentLength < COMPRESSION_MIN_SIZE;

    if ((response.body || compression.request.method === "HEAD") && !belowThreshold) {
      encoding = negotiateEncoding(compression.request.headers.get("accept-encoding"));
    }

    if (encoding) {
      res.removeHeader("content-length");
      res.setHeader("content-encoding", encoding);
      if (sourceEtag) res.setHeader("etag", encodeEtagForEncoding(sourceEtag, encoding));
    }
  }

  const responseEtag = getNodeHeaderValue(res, "etag");
  const isSuccessfulRetrieval =
    compression &&
    response.status >= 200 &&
    response.status < 300 &&
    (compression.request.method === "GET" || compression.request.method === "HEAD");
  if (
    isSuccessfulRetrieval &&
    compression.ownsIfMatch &&
    !matchesIfMatch(compression.request.headers.get("if-match"), responseEtag)
  ) {
    res.statusCode = 412;
    res.statusMessage = "Precondition Failed";
    for (const name of [
      "content-digest",
      "content-encoding",
      "content-length",
      "content-md5",
      "content-range",
      "content-type",
      "digest",
      "repr-digest",
    ]) {
      res.removeHeader(name);
    }
    res.setHeader("cache-control", "no-store");
    cancelResponseBody(response);
    res.end();
    return;
  }
  if (
    isSuccessfulRetrieval &&
    isNotModifiedRequest(
      compression.request,
      responseEtag,
      getNodeHeaderValue(res, "last-modified"),
    )
  ) {
    // Evaluate the selected representation's validators here. For encoded
    // requests the application did not receive `If-None-Match` or
    // `If-Modified-Since`, because it only knows identity metadata and could
    // otherwise short-circuit with a cross-encoding 304 before this adapter
    // derives the variant validator.
    res.statusCode = 304;
    res.statusMessage = "Not Modified";
    res.removeHeader("content-length");
    res.removeHeader("content-range");
    cancelResponseBody(response);
    res.end();
    return;
  }

  if (!response.body) {
    res.end();
    return;
  }

  // An event stream never ends on its own, so a graceful shutdown ends it (see
  // `endEventStream`); its source is one that can be ended from outside.
  const source: NodeJS.ReadableStream = isEventStream(res)
    ? createEndableSource(response.body, res)
    : Readable.fromWeb(response.body as never);
  // `incremental` flushes the compressor per written chunk: dynamic bodies
  // may be produced over time (SSE, streamed API responses), and a compressor
  // that only drains at end-of-stream would hold every event back until the
  // response closes. For single-chunk bodies (SSR documents, route-state
  // JSON) the extra flush costs a handful of bytes.
  await pipeToResponse(
    encoding ? createCompressedStream(source, encoding, { incremental: true }) : source,
    res,
  );
}

/** Aborts the request signal of an open response, keyed by that response. */
const abortOnEnd = new WeakMap<ServerResponse, () => void>();
/** Ends the body of an open event stream, keyed by its response. */
const endBodyOnEnd = new WeakMap<ServerResponse, () => void>();

function isEventStream(res: ServerResponse): boolean {
  return String(res.getHeader("content-type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");
}

/**
 * `Readable.fromWeb`, except that `endEventStream` can finish it: the app's
 * stream is cancelled and the readable ends, so whatever it is piped through
 * (a compressor too) flushes and the HTTP response completes.
 */
function createEndableSource(body: ReadableStream<Uint8Array>, res: ServerResponse): Readable {
  const reader = body.getReader();
  let ended = false;
  const source = new Readable({
    read() {
      reader.read().then(
        ({ done, value }) => {
          if (ended) return;
          if (done) {
            ended = true;
            source.push(null);
          } else {
            source.push(value);
          }
        },
        (error: unknown) => {
          if (!ended) source.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      );
    },
    destroy(error, callback) {
      if (!ended) {
        ended = true;
        reader.cancel(error ?? undefined).catch(() => undefined);
      }
      callback(error);
    },
  });
  endBodyOnEnd.set(res, () => {
    if (ended) return;
    ended = true;
    reader.cancel().catch(() => undefined);
    source.push(null);
  });
  return source;
}

/**
 * End an open event stream the way a completed response ends, instead of
 * cutting the connection: the request's `signal` aborts, the app's body
 * stream is cancelled, and the response finishes (a chunked body gets its
 * terminating chunk), so an `EventSource` sees a clean end and reconnects.
 * Returns `false` when `res` has no body this module is streaming yet; the
 * caller then closes it some other way.
 */
export function endEventStream(res: ServerResponse): boolean {
  const endBody = endBodyOnEnd.get(res);
  if (!endBody) return false;
  abortOnEnd.get(res)?.();
  endBody();
  return true;
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  // Cancellation is cleanup, not part of the conditional response. A
  // proxied/custom stream is allowed to reject cancellation; do not let that
  // replace a valid 304/412 with the outer 500 fallback (or hold the response
  // open while asynchronous cleanup settles).
  void response.body.cancel().catch(() => undefined);
}

function getNodeHeaderValue(res: ServerResponse, name: string): string | null {
  const value = res.getHeader(name);
  return Array.isArray(value) ? value.join(", ") : (value?.toString() ?? null);
}

export function writeNodeResponseHeaders(res: ServerResponse, headers: Headers): void {
  const setCookieHeaders = getSetCookieHeaders(headers);

  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookieHeaders.length > 0) {
      return;
    }
    res.setHeader(key, value);
  });

  if (setCookieHeaders.length > 0) {
    res.setHeader("set-cookie", setCookieHeaders);
  }

  stagedResponses.add(res);
  const onStaged = headerWaiters.get(res);
  if (onStaged) {
    headerWaiters.delete(res);
    onStaged();
  }
}

const stagedResponses = new WeakSet<ServerResponse>();
const headerWaiters = new WeakMap<ServerResponse, () => void>();

/**
 * Resolves once the response headers for `res` are staged, so its
 * `content-type` says what kind of response it is. A shutdown waits on this
 * for requests still answering: one may yet turn into an event stream.
 */
export function whenResponseHeadersStaged(res: ServerResponse): Promise<void> {
  if (stagedResponses.has(res) || res.headersSent || res.writableEnded) {
    return Promise.resolve();
  }
  return new Promise((resolveStaged) => {
    const previous = headerWaiters.get(res);
    headerWaiters.set(res, () => {
      previous?.();
      resolveStaged();
    });
  });
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
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
  options: { trustProxy?: boolean; canonicalOrigin?: string },
): URL {
  if (options.canonicalOrigin) {
    return new URL(options.canonicalOrigin);
  }

  const { protocol, host } = resolveOrigin(req, options.trustProxy ?? false);
  // `new URL()` reads userinfo, a path, a query, or a fragment out of a host
  // (`user:pw@host`, `a/b`, `evil?x`) and drops tabs, so the origin would not
  // be the one the client sent. Such a host is no host.
  if (!host || INVALID_HOST_RE.test(host)) throw new TypeError(`Invalid Host: ${host}`);
  return new URL(`${protocol}://${host}`);
}

/** Characters no `host[:port]` holds: whitespace, controls, `/ ? # @ \`. */
const INVALID_HOST_RE = /[\s\p{Cc}/?#@\\]/u;

function resolveOrigin(
  req: IncomingMessage,
  trustProxy: boolean,
): { protocol: string; host: string } {
  const socketProtocol = (req.socket as { encrypted?: boolean } | undefined)?.encrypted
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

/**
 * Buffer the request body into one exactly-sized `Uint8Array`: each chunk is
 * copied once, and the result owns its `ArrayBuffer` (a pooled `Buffer` would
 * expose neighbouring bytes through `.buffer`). Returns `null` for a body over
 * the limit; a declared `Content-Length` over it is rejected before any of the
 * body is read.
 */
async function readRequestBody(
  req: IncomingMessage,
  maxBodySize: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodySize) {
    return null;
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buf: Uint8Array = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalSize += buf.byteLength;
    if (totalSize > maxBodySize) {
      return null;
    }
    chunks.push(buf);
  }

  const body = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
