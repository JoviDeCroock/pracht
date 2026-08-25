/**
 * Streaming HTML documents.
 *
 * `buildHtmlDocumentParts()` gives us the document as prefix / afterShell /
 * suffix; this module writes those around the renderer's chunks instead of
 * around a finished string.
 *
 * Write order:
 *
 * 1. `prefix` — everything through `<div id="pracht-root">`. Flushed before the
 *    render starts, so `<head>` reaches the browser immediately and preloads
 *    begin while loaders are still running.
 * 2. the renderer's first chunk — the shell, i.e. the tree with every
 *    unresolved `<Suspense>` boundary rendered as its fallback.
 * 3. `afterShell` — closes the root div and writes the state and entry scripts,
 *    so hydration can start before the deferred subtrees land.
 * 4. the renderer's remaining chunks — its bootstrap script and one
 *    `<template>`-swap per boundary as each resolves.
 * 5. `suffix` — `</body></html>`.
 *
 * Step 2 relies on `renderToReadableStream` enqueuing exactly once per internal
 * write, with the shell first. That is the documented shape of the chunked
 * renderer, but it is an implementation detail rather than a contract — hence
 * `takeFirstChunk` being a named, testable step rather than an inline flag.
 */

import type { VNode } from "preact";

import { escapeHtml, escapeScriptText } from "./runtime-html.ts";
import { applyHeaders, applySecurityAndRouteHeaders } from "./runtime-headers.ts";
import { normalizeRouteError } from "./runtime-errors.ts";
import { getRenderToReadableStream } from "./runtime-response.ts";

export interface StreamingHtmlResponseOptions {
  /** The tree to render — route component inside its shell, as SSR builds it. */
  tree: VNode;
  /** Document pieces from `buildHtmlDocumentParts()`. */
  prefix: string;
  afterShell: string;
  suffix: string;
  status?: number;
  headers?: HeadersInit;
  /**
   * Request abort signal. Once it fires no more bytes are written, and the
   * renderer is drained after request-scoped deferred work has been aborted.
   */
  signal?: AbortSignal;
  /**
   * Called if the render fails *after* the first flush, when the status and
   * headers are already committed and no error document can be produced.
   */
  onError?: (error: unknown) => void;
  /** Abort request-scoped deferred work when the response consumer disconnects. */
  onCancel?: () => void;
  /**
   * Deferred loader values, written to the client as each settles. Their ids
   * match the out-of-band references `serializeDeferred()` recorded.
   */
  pending?: { id: string; promise: Promise<unknown> }[];
  /** CSP nonce for the deferred-data scripts pracht emits. */
  nonce?: string;
  /** Whether unexpected server error details may be exposed to the browser. */
  exposeErrorDetails?: boolean;
}

/**
 * Render `tree` into a streaming `text/html` response.
 *
 * Status and headers are committed with the first chunk. A failure before that
 * point still throws, so the caller can fall back to a normal error document;
 * after it, the stream is errored and `onError` is called.
 */
export async function streamingHtmlResponse(
  options: StreamingHtmlResponseOptions,
): Promise<Response> {
  const {
    tree,
    prefix,
    afterShell,
    suffix,
    status = 200,
    signal,
    onError,
    onCancel,
    pending = [],
    nonce,
    exposeErrorDetails = false,
  } = options;

  const renderToReadableStream = await getRenderToReadableStream();
  const encoder = new TextEncoder();

  // Produce the shell before constructing the outer response. The renderer
  // reports even synchronous component failures through its Web stream, so
  // awaiting the first read is the actual pre-flush error boundary: failures
  // still reach handlePrachtRequest's normal error-document path.
  const rendered = renderToReadableStream(tree);
  // `preact-render-to-string` exposes the same failure through `allReady` as
  // well as the body stream. The body remains authoritative below; observing
  // this second promise prevents an uncaught render from becoming an unhandled
  // rejection in Node.
  void rendered.allReady.catch(() => {});
  const reader = rendered.getReader();
  let firstRead: ReadableStreamReadResult<Uint8Array>;
  try {
    firstRead = await reader.read();
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  // Set by every path that ends the stream -- normal close, error, client
  // cancel, request abort. A deferred value can settle long after any of them,
  // and enqueuing on a closed controller throws.
  let closed = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(text));
      };
      const abort = () => {
        if (closed) return;
        closed = true;
        controller.error(signal?.reason ?? new DOMException("The streaming render was aborted."));
      };
      if (signal) {
        if (signal.aborted) {
          closed = true;
          controller.error(signal.reason ?? new DOMException("The streaming render was aborted."));
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      }

      const scriptOpen = `<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ""}>`;
      const queuedDeferredScripts: string[] = [];
      let deferChannelReady = pending.length === 0;
      const writeDeferred = (script: string) => {
        if (deferChannelReady) write(script);
        else queuedDeferredScripts.push(script);
      };

      // Each deferred value gets its own script as it settles. Writing them
      // from the promise (rather than after the renderer finishes) is what
      // lets the client resume a boundary while later ones are still pending.
      const deferredWrites = pending.map(({ id, promise }) =>
        promise.then(
          (value) => {
            writeDeferred(
              `${scriptOpen}window.__PRACHT_DEFER__.r(${escapeScriptText(JSON.stringify(id))},${escapeScriptText(JSON.stringify(value) ?? "null")})</script>`,
            );
          },
          (error: unknown) => {
            // A deferred value cannot redirect or set headers -- the response
            // is already committed -- so a rejection is delivered as data and
            // rendered by the nearest ErrorBoundary.
            const serializedError = normalizeRouteError(error, {
              exposeDetails: exposeErrorDetails,
            });
            writeDeferred(
              `${scriptOpen}window.__PRACHT_DEFER__.e(${escapeScriptText(JSON.stringify(id))},${escapeScriptText(JSON.stringify(serializedError))})</script>`,
            );
          },
        ),
      );

      try {
        write(prefix);

        let takeFirstChunk = true;
        if (!firstRead.done) {
          controller.enqueue(firstRead.value);
          takeFirstChunk = false;
          // The shim has to exist before any deferred script runs, and the
          // async client runtime may execute as soon as it is fetched. The
          // document builder places the shim before that entry script.
          write(afterShell);
          deferChannelReady = true;
          for (const script of queuedDeferredScripts) write(script);
          queuedDeferredScripts.length = 0;
        }

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // A read already in flight when the consumer cancels still resolves
          // once; enqueuing it would throw on the closed controller.
          if (closed) break;
          controller.enqueue(value);
        }

        if (closed) {
          // The Web renderer exposes no abort hook. Keep consuming its stream
          // after request-scoped work is aborted so its controller never queues
          // unbounded chunks or writes into a canceled stream.
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
          return;
        }

        // A tree with no content at all never produces a chunk, so the shell
        // close-out would otherwise be skipped entirely.
        if (takeFirstChunk) {
          write(afterShell);
          deferChannelReady = true;
          for (const script of queuedDeferredScripts) write(script);
          queuedDeferredScripts.length = 0;
        }

        // The renderer resolves once every boundary it saw has flushed, but a
        // deferred value with no boundary reading it has no other join point.
        await Promise.all(deferredWrites);

        write(suffix);
        if (closed) return;
        closed = true;
        controller.close();
      } catch (error) {
        if (closed) return;
        // Past the first flush the response is committed: the status is sent
        // and no error document is possible. Error the stream so the client
        // sees a truncated response rather than a silently short one.
        closed = true;
        onError?.(error);
        controller.error(error);
      } finally {
        if (signal) signal.removeEventListener("abort", abort);
        reader.releaseLock();
      }
    },
    cancel() {
      // Client hung up. Abort request-scoped work; start() drains the renderer
      // because preact-render-to-string's Web stream has no abort hook.
      closed = true;
      onCancel?.();
    },
  });

  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (options.headers) applyHeaders(headers, options.headers);
  applySecurityAndRouteHeaders(headers, { isRouteStateRequest: false });

  return new Response(body, { status, headers });
}
