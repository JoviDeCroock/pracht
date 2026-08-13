import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { isClientDisconnectError } from "./node-disconnect.ts";

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

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  writeNodeResponseHeaders(res, response.headers);

  if (!response.body) {
    res.end();
    return;
  }

  await pipeToResponse(Readable.fromWeb(response.body as never), res);
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
}

function getSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
}
