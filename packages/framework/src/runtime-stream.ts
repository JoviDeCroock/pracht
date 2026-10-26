/**
 * Streaming HTML documents.
 *
 * `buildHtmlDocumentParts()` gives us the document as prefix / afterShell /
 * suffix; this module writes those around the renderer's chunks instead of
 * around a finished string.
 *
 * Write order:
 *
 * 1. `prefix` — everything through `<div id="pracht-root">`. Flushed before deferred
 *    subtrees settle, so `<head>` reaches the browser immediately and preloads
 *    begin while deferred loader work is still running.
 * 2. the renderer's first chunk — the shell, i.e. the tree with every
 *    unresolved `<Suspense>` boundary rendered as its fallback.
 * 3. `afterShell` — closes the root div and writes the state and defer-channel
 *    bootstrap. On Preact 11 it also carries the async client entry, so the
 *    shell hydrates while boundaries are still arriving; their resumption
 *    waits for the complete document (see streamed-document.ts).
 * 4. the renderer's remaining chunks — its bootstrap script and one
 *    `<preact-island>` swap per boundary as each resolves.
 * 5. `suffix` — `</body></html>`, preceded by the client entry on Preact 10,
 *    which cannot resume a boundary whose fallback the renderer replaced.
 *
 * Step 2 relies on `renderToReadableStream` enqueuing exactly once per internal
 * write, with the shell first. That is the documented shape of the chunked
 * renderer, but it is an implementation detail rather than a contract — hence
 * `takeFirstChunk` being a named, testable step rather than an inline flag.
 */

import type { VNode } from "preact";

import { escapeHtml, escapeScriptText } from "./runtime-html.ts";
import { applyHeaders, applySecurityAndRouteHeaders, ownResponse } from "./runtime-headers.ts";
import { normalizeRouteError } from "./runtime-errors.ts";
import { encodeRouteData } from "./route-data-codec.ts";
import { getRenderToReadableStream } from "./runtime-response.ts";
import { renderStreamedShell } from "./streamed-shell.ts";

// `client.richData` (see route-data-codec.ts). Declared in this module rather
// than imported: Rolldown folds the condition only within a module, so an
// imported flag would keep the codec chunk in every multi-chunk build.
declare const __PRACHT_RICH_DATA__: boolean | undefined;
const RICH_ROUTE_DATA =
  typeof __PRACHT_RICH_DATA__ !== "undefined" && __PRACHT_RICH_DATA__ === true;

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
  /** Called once the body has ended: closed, errored, or drained after a cancel. */
  onSettled?: () => void;
  /**
   * Deferred loader values, written to the client as each settles. Their ids
   * match the out-of-band references `serializeDeferred()` recorded.
   */
  pending?: { id: string; promise: Promise<unknown> }[];
  /** CSP nonce for every inline script in the stream, the renderer's included. */
  nonce?: string;
  /** Whether unexpected server error details may be exposed to the browser. */
  exposeErrorDetails?: boolean;
}

const streamingResponseBodies = new WeakSet<ReadableStream<Uint8Array>>();

const RENDERER_SCRIPT_OPEN = new TextEncoder().encode("<script>");
const RENDERER_ISLAND_OPEN = new TextEncoder().encode("<preact-island");

/**
 * Written right before the renderer's bootstrap, ahead of any boundary.
 *
 * The renderer's `<preact-island>` schedules its swap from `connectedCallback`,
 * which runs when the parser reaches the start tag. The parser may yield
 * before the island's children, and a frame in that gap swaps an empty island:
 * the boundary's markup is lost and hydration has to render it from scratch.
 * The swap is started from a script after each island instead, which only
 * runs once the parser has finished the element before it. The callback is
 * replaced while the bootstrap defines the element, because `define()` reads
 * lifecycle callbacks once.
 */
const ISLAND_SWAP_PATCH =
  "(function(){var d=customElements.define,c;" +
  'customElements.define=function(n,C,o){if(n=="preact-island"){customElements.define=d;' +
  "c=C.prototype.connectedCallback;C.prototype.connectedCallback=function(){}}" +
  "return d.call(this,n,C,o)};" +
  'window.__PRACHT_ISLAND__=function(s){var e=s.previousSibling;if(c&&e&&e.localName=="preact-island")c.call(e)}})()';
const ISLAND_SWAP_TRIGGER = "__PRACHT_ISLAND__(document.currentScript)</script>";

function startsWith(chunk: Uint8Array, prefix: Uint8Array): boolean {
  if (chunk.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (chunk[i] !== prefix[i]) return false;
  }
  return true;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Adjust a post-shell renderer chunk.
 *
 * `renderToReadableStream` has no nonce option. After the shell, its chunks
 * are the `<div hidden>` wrapper, one bootstrap `<script>`, and boundary
 * subtrees wrapped in `<preact-island>`, so the only post-shell chunk that
 * opens with a bare `<script>` is that bootstrap. It gets the nonce and is
 * preceded by the swap patch; each island is followed by its swap trigger.
 */
function prepareRendererChunk(
  chunk: Uint8Array,
  scriptOpen: Uint8Array,
  encoder: TextEncoder,
): Uint8Array {
  if (startsWith(chunk, RENDERER_ISLAND_OPEN)) {
    return concatBytes(chunk, scriptOpen, encoder.encode(ISLAND_SWAP_TRIGGER));
  }
  if (startsWith(chunk, RENDERER_SCRIPT_OPEN)) {
    return concatBytes(
      scriptOpen,
      encoder.encode(`${ISLAND_SWAP_PATCH}</script>`),
      scriptOpen,
      chunk.subarray(RENDERER_SCRIPT_OPEN.length),
    );
  }
  return chunk;
}

/** Read `reader` to its end, discarding every chunk. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Nothing is left to deliver the failure to.
  }
}

/** Whether a response body was created by Pracht's streaming document renderer. */
export function isStreamingHtmlResponse(response: Response): boolean {
  return response.body !== null && streamingResponseBodies.has(response.body);
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
    onSettled,
    pending = [],
    nonce,
    exposeErrorDetails = false,
  } = options;

  const renderToReadableStream = await getRenderToReadableStream();
  const encoder = new TextEncoder();

  // Produce the shell before constructing the outer response. A shell error
  // throws from here, so it still reaches handlePrachtRequest's normal
  // error-document path.
  const shell = renderStreamedShell(tree, renderToReadableStream);
  const rendered = shell.result;
  // `preact-render-to-string` exposes a stream failure through `allReady` as
  // well as the body stream. The body remains authoritative below; observing
  // this second promise prevents it from becoming an unhandled rejection.
  void rendered.allReady.catch(() => {});
  const reader = rendered.getReader();
  if (shell.failed) {
    // Boundaries that suspended before the error still write when they
    // settle, so the renderer's stream has to stay open until they have.
    void drain(reader);
    throw shell.error;
  }
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

  let openDeferChannel: (() => void) | undefined;
  const deferChannelReady =
    pending.length === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          openDeferChannel = resolve;
        });
  let releaseDemand: (() => void) | undefined;
  const wakeWriter = () => {
    const release = releaseDemand;
    releaseDemand = undefined;
    release?.();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // `start()` must return synchronously so the stream can call `pull()`.
      // Every producer writes through this chain, which preserves chunk order
      // while waiting for downstream demand before allocating the next chunk.
      let writeTail = Promise.resolve();
      const writeChunk = (createChunk: () => Uint8Array): Promise<void> => {
        const write = writeTail.then(async () => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) <= 0) {
            await new Promise<void>((resolve) => {
              releaseDemand = resolve;
            });
          }
          if (closed) return;
          controller.enqueue(createChunk());
        });
        writeTail = write.catch(() => {});
        return write;
      };
      const write = (text: string | (() => string)) =>
        writeChunk(() => encoder.encode(typeof text === "function" ? text() : text));
      const abort = () => {
        if (closed) return;
        closed = true;
        openDeferChannel?.();
        wakeWriter();
        controller.error(signal?.reason ?? new DOMException("The streaming render was aborted."));
      };
      if (signal) {
        if (signal.aborted) {
          closed = true;
          openDeferChannel?.();
          controller.error(signal.reason ?? new DOMException("The streaming render was aborted."));
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      }

      const scriptOpen = `<script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ""}>`;
      const scriptOpenBytes = encoder.encode(scriptOpen);
      const writeDeferred = async (script: () => string) => {
        await deferChannelReady;
        await write(script);
      };

      // A rejection is delivered as data and rendered by the nearest
      // ErrorBoundary: a deferred value cannot redirect or set headers once
      // the response is committed.
      const errorScript = (id: string, error: unknown) => {
        const serializedError = normalizeRouteError(error, {
          exposeDetails: exposeErrorDetails,
        });
        return `${scriptOpen}window.__PRACHT_DEFER__.e(${escapeScriptText(JSON.stringify(id))},${escapeScriptText(JSON.stringify(serializedError))})</script>`;
      };

      // Each deferred value gets its own script as it settles. Writing them
      // from the promise (rather than after the renderer finishes) is what
      // lets the client resume a boundary while later ones are still pending.
      // Resolved values are serialized like the hydration state (with rich
      // data on, a bare `undefined` is the one value the encoding leaves
      // as-is); one that cannot be serialized reaches its boundary as an error
      // instead.
      const deferredWrites = pending.map(({ id, promise }) =>
        promise.then(
          async (value) => {
            await writeDeferred(() => {
              let json: string;
              try {
                json = RICH_ROUTE_DATA
                  ? (JSON.stringify(encodeRouteData(value, `the deferred value "${id}"`)) ??
                    "undefined")
                  : (JSON.stringify(value) ?? "null");
              } catch (error) {
                return errorScript(id, error);
              }
              return `${scriptOpen}window.__PRACHT_DEFER__.r(${escapeScriptText(JSON.stringify(id))},${escapeScriptText(json)})</script>`;
            });
          },
          async (error: unknown) => {
            await writeDeferred(() => errorScript(id, error));
          },
        ),
      );

      const allDeferredWrites = Promise.all(deferredWrites);
      void allDeferredWrites.catch(() => {});

      void (async () => {
        try {
          await write(prefix);

          let takeFirstChunk = true;
          if (!firstRead.done) {
            await writeChunk(() => firstRead.value);
            takeFirstChunk = false;
            // The shim has to exist before any deferred script runs, and the
            // async client runtime may execute as soon as it is fetched. The
            // document builder places the shim before that entry script.
            await write(afterShell);
            openDeferChannel?.();
          }

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // A read already in flight when the consumer cancels still resolves
            // once; enqueuing it would throw on the closed controller.
            if (closed) break;
            await writeChunk(() => prepareRendererChunk(value, scriptOpenBytes, encoder));
          }

          if (closed) {
            // The Web renderer exposes no abort hook. Keep consuming its stream
            // after request-scoped work is aborted so its controller never queues
            // unbounded chunks or writes into a canceled stream.
            await drain(reader);
            return;
          }

          // A tree with no content at all never produces a chunk, so the shell
          // close-out would otherwise be skipped entirely.
          if (takeFirstChunk) {
            await write(afterShell);
            openDeferChannel?.();
          }

          // The renderer resolves once every boundary it saw has flushed, but a
          // deferred value with no boundary reading it has no other join point.
          await allDeferredWrites;

          await write(suffix);
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
          onSettled?.();
        }
      })();
    },
    pull() {
      wakeWriter();
    },
    cancel() {
      // Client hung up. Abort request-scoped work; start() drains the renderer
      // because preact-render-to-string's Web stream has no abort hook.
      closed = true;
      openDeferChannel?.();
      wakeWriter();
      onCancel?.();
    },
  });

  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (options.headers) applyHeaders(headers, options.headers);
  applySecurityAndRouteHeaders(headers, { isRouteStateRequest: false });
  // Route headers are prepared before the renderer runs, so a declared body
  // length cannot describe the document after streamed chunks are appended.
  headers.delete("content-length");

  streamingResponseBodies.add(body);
  return ownResponse(new Response(body, { status, headers }));
}
