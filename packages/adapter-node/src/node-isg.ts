import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { basename, dirname, join } from "node:path";
import {
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  handlePrachtRequest,
  isCacheableISGResponse,
  isDangerousPrerenderHeader,
  restoreBasePathInRequest,
} from "@pracht/core/server";
import type { NodeAdapterOptions } from "./node-handler.ts";
import { ISG_SNAPSHOT_HEADERS_SUFFIX } from "./node-static.ts";

// Shared across all handler instances in this process so a stampede of stale
// requests (or repeated webhook posts) for the same output file collapses
// into a single regeneration instead of N parallel renders racing to write.
const regenerationSingleFlight = createRevalidationSingleFlight();

/** The page rendered, but its snapshot could not be saved to disk. */
export class ISGSnapshotWriteError extends Error {
  readonly htmlPath: string;

  constructor(htmlPath: string, cause: unknown) {
    super(`Could not save the ISG page ${htmlPath}`, { cause });
    this.name = "ISGSnapshotWriteError";
    this.htmlPath = htmlPath;
  }
}

export interface ISGSnapshotWriteGuard {
  /** Whether a stale page may be regenerated now; `false` while its last write is backing off. */
  canRegenerate(htmlPath: string): boolean;
  /**
   * Record a failed snapshot write. With `retryAfterMs`, stale regeneration of
   * `htmlPath` pauses that long, so a read-only filesystem costs one render per
   * revalidate window instead of one per request. Warns once per handler.
   */
  failed(htmlPath: string, error: unknown, retryAfterMs?: number): void;
  succeeded(htmlPath: string): void;
}

export function createISGSnapshotWriteGuard(now: () => number = Date.now): ISGSnapshotWriteGuard {
  // Only paths with a snapshot on disk are recorded here, so the map is
  // bounded by the static directory rather than by request URLs.
  const retryAt = new Map<string, number>();
  let warned = false;
  return {
    canRegenerate(htmlPath) {
      const at = retryAt.get(htmlPath);
      return at === undefined || now() >= at;
    },
    failed(htmlPath, error, retryAfterMs) {
      if (retryAfterMs !== undefined) retryAt.set(htmlPath, now() + retryAfterMs);
      if (warned) return;
      warned = true;
      const cause = error instanceof ISGSnapshotWriteError ? error.cause : error;
      const code = (cause as { code?: unknown } | null)?.code;
      const reason = cause instanceof Error ? cause.message : String(cause);
      console.warn(
        `[pracht] ISG could not save a page under ${dirname(htmlPath)}` +
          `${typeof code === "string" ? ` (${code})` : ""}: ${reason}. ` +
          "ISG pages keep being served from their existing snapshot, or rendered per request " +
          "when there is none, and a stale page is re-rendered at most once per revalidate " +
          "window. Make the static directory writable to persist regenerated pages. " +
          "This warning is shown once.",
      );
    },
    succeeded(htmlPath) {
      retryAt.delete(htmlPath);
    },
  };
}

/**
 * Publish an ISG snapshot as one filesystem replacement. Besides preventing
 * readers from observing a partially-written document, the replacement gives
 * the file a new durable identity so validators and compression caches in
 * restarted or sibling Node workers cannot alias a same-size rewrite whose
 * mtime is unchanged on a coarse-timestamp filesystem. `beforePublish` runs
 * with the fully written temporary file just before it replaces `htmlPath`.
 */
export async function writeISGFile(
  htmlPath: string,
  html: string,
  beforePublish?: (temporaryPath: string) => Promise<void>,
): Promise<void> {
  const directory = dirname(htmlPath);
  await mkdir(directory, { recursive: true });
  const existing = await stat(htmlPath).catch(() => null);
  const temporaryPath = join(
    directory,
    `.${basename(htmlPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, html, {
      encoding: "utf-8",
      flush: true,
      ...(existing ? { mode: existing.mode & 0o777 } : {}),
    });
    await beforePublish?.(temporaryPath);
    await rename(temporaryPath, htmlPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/** Response headers that describe one transfer, not the document. */
const TRANSFER_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "date",
  "etag",
  "keep-alive",
  "last-modified",
  "transfer-encoding",
  "x-pracht-isg",
]);

/**
 * The document headers an ISG render produced, as they should be replayed
 * with its HTML: transfer headers are dropped and credential-shaped headers
 * are stripped, since the snapshot is served to every visitor.
 */
export function getISGSnapshotHeaders(
  response: Response,
  pathname: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const dangerous: string[] = [];
  for (const [name, value] of response.headers) {
    if (isDangerousPrerenderHeader(name)) dangerous.push(name);
    else if (!TRANSFER_HEADERS.has(name)) headers[name] = value;
  }
  if (dangerous.length > 0) {
    console.error(
      `Stripped ${dangerous.map((name) => `"${name}"`).join(", ")} from the ISG snapshot for ` +
        `"${pathname}" — snapshots are replayed to every visitor. Move cookies and credential ` +
        "headers to API routes, middleware responses, or an SSR route.",
    );
  }
  return headers;
}

interface ISGSnapshotHeadersRecord {
  /** Identity of the HTML file these headers were rendered with. */
  file: string;
  headers: Record<string, string> | null;
}

// Keyed by HTML path. An entry is only used while the file on disk still has
// the identity it was recorded for, so a redeploy that replaces the HTML falls
// back to the build's headers manifest.
const snapshotHeadersCache = new Map<string, ISGSnapshotHeadersRecord>();

function getSnapshotFileIdentity(fileStat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): string {
  return `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
}

function getSnapshotHeadersPath(htmlPath: string): string {
  return join(dirname(htmlPath), `.${basename(htmlPath)}${ISG_SNAPSHOT_HEADERS_SUFFIX}`);
}

/**
 * Publish an ISG snapshot with the document headers it was rendered with.
 * The headers are recorded first, for the identity the HTML file will have
 * once renamed into place, so no reader (in this or another process) sees
 * the new HTML before its headers. If recording fails, the HTML is served
 * with the build's headers, as before.
 */
export async function writeISGSnapshot(
  htmlPath: string,
  html: string,
  headers: Record<string, string>,
): Promise<void> {
  await writeISGFile(htmlPath, html, async (temporaryPath) => {
    // A rename keeps the device, inode, size, and mtime.
    const record: ISGSnapshotHeadersRecord = {
      file: getSnapshotFileIdentity(await stat(temporaryPath)),
      headers,
    };
    snapshotHeadersCache.set(htmlPath, record);
    await writeISGFile(getSnapshotHeadersPath(htmlPath), JSON.stringify(record)).catch((error) => {
      console.error(`[pracht] Could not record the ISG snapshot headers for ${htmlPath}:`, error);
    });
  });
}

/**
 * The document headers recorded for the ISG snapshot whose stats are given,
 * or `null` when it has none (a build-time snapshot, or one replaced since).
 */
export async function readISGSnapshotHeaders(
  htmlPath: string,
  fileStat: { dev: number; ino: number; size: number; mtimeMs: number },
): Promise<Record<string, string> | null> {
  const file = getSnapshotFileIdentity(fileStat);
  const cached = snapshotHeadersCache.get(htmlPath);
  if (cached?.file === file) return cached.headers;

  const stored = await readFile(getSnapshotHeadersPath(htmlPath), "utf-8")
    .then((source) => parseSnapshotHeadersRecord(source))
    .catch(() => null);
  const headers = stored?.file === file ? stored.headers : null;
  snapshotHeadersCache.set(htmlPath, { file, headers });
  return headers;
}

function parseSnapshotHeadersRecord(source: string): ISGSnapshotHeadersRecord | null {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object") return null;
  const { file, headers } = value as Record<string, unknown>;
  if (typeof file !== "string" || !headers || typeof headers !== "object") return null;
  const entries = Object.entries(headers);
  if (!entries.every(([, header]) => typeof header === "string")) return null;
  return { file, headers: Object.fromEntries(entries) as Record<string, string> };
}

/**
 * Build the request and context an ISG render runs with. The result is shared
 * with every later visitor, so neither may carry anything from the request
 * that triggered it: the `Request` is path-only, and `createContext` gets a
 * detached `req`/`res` pair built from that `Request` instead of the
 * visitor's, whose headers would still hold cookies and credentials.
 * `pathname` is a base-free manifest key; `origin` only supplies the origin.
 * Call `finish()` once the render's body has been consumed (or failed) so the
 * detached response emits `finish`/`close` like a real one.
 */
export async function createISGRenderInput<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  origin: Request | undefined,
): Promise<{ request: Request; context: TContext | undefined; finish: () => void }> {
  // Manifest keys are always base-free, regardless of whether the incoming
  // proxy request retained the public base. Restore it on the synthetic
  // regeneration Request before application code observes the URL.
  const request = restoreBasePathInRequest(createISGRegenerationRequest(pathname, origin));
  if (!options.createContext) return { request, context: undefined, finish: () => {} };

  const { finish, ...exchange } = createDetachedNodeExchange(request);
  try {
    const context = await options.createContext({ request, ...exchange });
    return { request, context, finish };
  } catch (error) {
    finish();
    throw error;
  }
}

/**
 * A `node:http` request/response pair that mirrors a sanitized `Request` and
 * reaches no client: the request carries only that `Request`'s headers and an
 * empty, already-ended body, and the response writes into a discarding
 * socket. Context factories that read `req.headers` or hook `res` events keep
 * working; they simply see no visitor.
 */
function createDetachedNodeExchange(request: Request): {
  req: IncomingMessage;
  res: ServerResponse;
  finish: () => void;
} {
  const url = new URL(request.url);
  const req = new IncomingMessage(new Socket());
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.httpVersion = "1.1";
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of request.headers) headers[name] = value;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flat();
  req.complete = true;
  req.push(null);

  const sink = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const res = new ServerResponse(req);
  res.assignSocket(sink as Socket);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    // Closing the sink after the response flushes emits `close` on both.
    res.once("finish", () => sink.destroy());
    if (!res.writableEnded) res.end();
    else if (res.writableFinished) sink.destroy();
  };
  return { req, res, finish };
}

/**
 * Regenerate an ISG page and write it to disk. Returns `true` when fresh
 * HTML was written, `false` when the render did not produce cacheable
 * 200 HTML (the stale on-disk copy is kept in that case).
 */
export async function regenerateISGPage<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  htmlPath: string,
  origin?: Request,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<boolean> {
  return regenerationSingleFlight(htmlPath, async () => {
    const { request, context, finish } = await createISGRenderInput(options, pathname, origin);
    try {
      return await renderAndWriteISGPage(options, request, context, htmlPath, waitUntil);
    } finally {
      finish();
    }
  });
}

async function renderAndWriteISGPage<TContext>(
  options: NodeAdapterOptions<TContext>,
  request: Request,
  context: TContext | undefined,
  htmlPath: string,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): Promise<boolean> {
  const response = await handlePrachtRequest({
    app: options.app,
    basePathStripped: false,
    context,
    registry: options.registry,
    request,
    clientEntryUrl: options.clientEntryUrl,
    islandsEntryUrl: options.islandsEntryUrl,
    islandsBootstrapRequired: options.islandsBootstrapRequired,
    cssManifest: options.cssManifest,
    cssContentManifest: options.cssContentManifest,
    jsManifest: options.jsManifest,
    waitUntil,
  });

  if (response.status !== 200 || !isCacheableISGResponse(response)) {
    return false;
  }

  const headers = getISGSnapshotHeaders(response, new URL(request.url).pathname);
  const html = await response.text();
  try {
    await writeISGSnapshot(htmlPath, html, headers);
  } catch (error) {
    throw new ISGSnapshotWriteError(htmlPath, error);
  }
  return true;
}

export { createISGRegenerationRequest };
