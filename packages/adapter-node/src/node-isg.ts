import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { basename, dirname, join } from "node:path";
import {
  captureISGSnapshot,
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  decodeISGSnapshot,
  encodeISGSnapshot,
  handlePrachtRequest,
  isISGSnapshotRejection,
  restoreBasePathInRequest,
  type ISGSnapshot,
} from "@pracht/core/server";
import type { NodeAdapterOptions } from "./node-handler.ts";
import { ISG_SNAPSHOT_SUFFIX } from "./node-static.ts";

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

/** A snapshot read from disk, with what serving it needs. */
export interface StoredISGSnapshot {
  snapshot: ISGSnapshot;
  /** The snapshot file. */
  path: string;
  /** The file's local identity; keys process-local caches, never sent. */
  version: string;
  body: Buffer;
  /** A validator derived from the HTML alone, so replicas agree on it. */
  etag: string;
}

/**
 * The file a page's regenerated snapshot is published to, beside its build
 * HTML. Each build has its own (`.index.html.<buildId>.pracht-isg.json`), so
 * two builds serving one directory during a rollover never overwrite each
 * other's pages. Without a build id it is the one name older releases used.
 */
export function getISGSnapshotPath(htmlPath: string, buildId?: string | null): string {
  const name = basename(htmlPath);
  return join(
    dirname(htmlPath),
    buildId
      ? `.${name}.${buildIdFileSegment(buildId)}${ISG_SNAPSHOT_SUFFIX}`
      : `.${name}${ISG_SNAPSHOT_SUFFIX}`,
  );
}

/** A build id as a file name segment: itself when that is safe, else a digest. */
function buildIdFileSegment(buildId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(buildId)
    ? buildId
    : createHash("sha256").update(buildId).digest("base64url").slice(0, 22);
}

function getFileVersion(fileStat: { dev: number; ino: number; size: number; mtimeMs: number }) {
  return `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
}

// Decoded snapshots by file, while the file keeps the version they were read
// at. Bounded by bytes: a miss only costs a read of the file.
const MAX_STORED_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const storedSnapshots = new Map<string, StoredISGSnapshot>();
let storedSnapshotBytes = 0;

function rememberSnapshot(stored: StoredISGSnapshot): void {
  forgetSnapshot(stored.path);
  if (stored.body.byteLength > MAX_STORED_SNAPSHOT_BYTES) return;
  storedSnapshots.set(stored.path, stored);
  storedSnapshotBytes += stored.body.byteLength;
  for (const [path, oldest] of storedSnapshots) {
    if (storedSnapshotBytes <= MAX_STORED_SNAPSHOT_BYTES) break;
    storedSnapshots.delete(path);
    storedSnapshotBytes -= oldest.body.byteLength;
  }
}

function forgetSnapshot(path: string): void {
  const existing = storedSnapshots.get(path);
  if (!existing) return;
  storedSnapshots.delete(path);
  storedSnapshotBytes -= existing.body.byteLength;
}

function storeSnapshot(path: string, version: string, snapshot: ISGSnapshot): StoredISGSnapshot {
  const body = Buffer.from(snapshot.html, "utf-8");
  const etag = `W/"pracht-file-${createHash("sha256").update(body).digest("base64url")}"`;
  const stored = { snapshot, path, version, body, etag };
  rememberSnapshot(stored);
  return stored;
}

/**
 * Publish a regenerated page as one file replacement, so a reader in this or
 * another process sees either the previous snapshot or this one, never HTML
 * from one render with headers from another. Other builds' snapshots stay:
 * a process still serving one of them during a rollover needs its own, and
 * `pracht build` empties the client directory anyway.
 */
export async function writeISGSnapshot(htmlPath: string, snapshot: ISGSnapshot): Promise<void> {
  const path = getISGSnapshotPath(htmlPath, snapshot.buildId);
  await writeISGFile(path, encodeISGSnapshot(snapshot), async (temporaryPath) => {
    // A rename keeps the device, inode, size, and mtime.
    storeSnapshot(path, getFileVersion(await stat(temporaryPath)), snapshot);
  });
}

/**
 * The regenerated snapshot of the page whose build HTML is `htmlPath`, or
 * `null` when it has none. With `buildId`, only that build's snapshot is
 * read, so a redeploy into the same static directory starts from its own HTML
 * and a build still serving beside it keeps its own pages. A snapshot an
 * older release wrote under the shared name counts when that same build
 * rendered it.
 */
export async function readISGSnapshot(
  htmlPath: string,
  buildId: string | undefined,
): Promise<StoredISGSnapshot | null> {
  if (buildId === undefined) return readSnapshotFile(getISGSnapshotPath(htmlPath), undefined);
  return (
    (await readSnapshotFile(getISGSnapshotPath(htmlPath, buildId), buildId)) ??
    readSnapshotFile(getISGSnapshotPath(htmlPath), buildId)
  );
}

async function readSnapshotFile(
  path: string,
  buildId: string | undefined,
): Promise<StoredISGSnapshot | null> {
  const file = await open(path, "r").catch(() => null);
  if (!file) return null;
  let stored: StoredISGSnapshot | null;
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) return null;
    const version = getFileVersion(fileStat);
    const cached = storedSnapshots.get(path);
    if (cached?.version === version) {
      stored = cached;
    } else {
      const snapshot = decodeISGSnapshot(await file.readFile("utf-8"));
      stored = snapshot ? storeSnapshot(path, version, snapshot) : null;
    }
  } finally {
    await file.close();
  }
  if (!stored) return null;
  if (buildId !== undefined && stored.snapshot.buildId !== buildId) return null;
  return stored;
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
 * Regenerate an ISG page and publish its snapshot. Returns `true` when a
 * fresh snapshot was written, `false` when the render did not produce
 * cacheable 200 HTML (the current page is kept in that case).
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

  const snapshot = await captureISGSnapshot(response, {
    buildId: options.buildId,
    pathname: new URL(request.url).pathname,
  });
  if (isISGSnapshotRejection(snapshot)) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  try {
    await writeISGSnapshot(htmlPath, snapshot);
  } catch (error) {
    throw new ISGSnapshotWriteError(htmlPath, error);
  }
  return true;
}

export { createISGRegenerationRequest };
