import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import {
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  handlePrachtRequest,
  isCacheableISGResponse,
  restoreBasePathInRequest,
} from "@pracht/core/server";
import type { NodeAdapterOptions } from "./node-handler.ts";

// Shared across all handler instances in this process so a stampede of stale
// requests (or repeated webhook posts) for the same output file collapses
// into a single regeneration instead of N parallel renders racing to write.
const regenerationSingleFlight = createRevalidationSingleFlight();

/**
 * Publish an ISG snapshot as one filesystem replacement. Besides preventing
 * readers from observing a partially-written document, the replacement gives
 * the file a new durable identity so validators and compression caches in
 * restarted or sibling Node workers cannot alias a same-size rewrite whose
 * mtime is unchanged on a coarse-timestamp filesystem.
 */
export async function writeISGFile(htmlPath: string, html: string): Promise<void> {
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
    await rename(temporaryPath, htmlPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Build the request and context an ISG render runs with. The result is shared
 * with every later visitor, so neither may carry anything from the request
 * that triggered it: the `Request` is path-only, and `createContext` gets a
 * detached `req`/`res` pair built from that `Request` instead of the
 * visitor's, whose headers would still hold cookies and credentials.
 * `pathname` is a base-free manifest key; `origin` only supplies the origin.
 */
export async function createISGRenderInput<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  origin: Request | undefined,
): Promise<{ request: Request; context: TContext | undefined }> {
  // Manifest keys are always base-free, regardless of whether the incoming
  // proxy request retained the public base. Restore it on the synthetic
  // regeneration Request before application code observes the URL.
  const request = restoreBasePathInRequest(createISGRegenerationRequest(pathname, origin));
  const context = options.createContext
    ? await options.createContext({ request, ...createDetachedNodeExchange(request) })
    : undefined;
  return { request, context };
}

/**
 * A `node:http` request/response pair that mirrors a sanitized `Request` and
 * is connected to nothing: the request carries only that `Request`'s headers
 * and an empty, already-ended body, and anything written to the response is
 * discarded. Context factories that read `req.headers` keep working; they
 * simply see no visitor.
 */
function createDetachedNodeExchange(request: Request): {
  req: IncomingMessage;
  res: ServerResponse;
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
  return { req, res: new ServerResponse(req) };
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
    const { request, context } = await createISGRenderInput(options, pathname, origin);

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

    const html = await response.text();
    await writeISGFile(htmlPath, html);
    return true;
  });
}

export { createISGRegenerationRequest };
