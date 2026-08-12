import { applyHeaders } from "./runtime-headers.ts";

/**
 * One Server-Sent Events message. `data` is the only required field: strings
 * are sent as-is (multi-line values become one `data:` line per line, exactly
 * as the SSE wire format requires), anything else is `JSON.stringify`ed.
 */
export interface EventStreamMessage {
  /** Payload. Strings pass through; other values are JSON-serialized. */
  data: unknown;
  /** Optional event name, dispatched to `addEventListener(event)` listeners. */
  event?: string;
  /** Optional event id, exposed as `lastEventId` and replayed by browsers in `Last-Event-ID`. */
  id?: string;
  /** Optional reconnection delay hint in milliseconds. */
  retry?: number;
}

export interface EventStreamInit {
  /**
   * Emit a comment line (`:keep-alive`) every `keepAlive` seconds so proxies
   * and load balancers with idle timeouts keep the connection open. Off when
   * omitted. The timer is cleared as soon as the stream closes or the client
   * disconnects.
   */
  keepAlive?: number;
  /** Extra headers merged over the SSE defaults. */
  headers?: HeadersInit;
}

export interface EventStream {
  /** The streaming `Response` to return from the API route handler. */
  response: Response;
  /**
   * Serialize and enqueue one message. Returns `false` — instead of throwing —
   * once the stream is closed or the client has disconnected, so producer
   * loops can use the return value as their stop condition.
   */
  send(message: EventStreamMessage): boolean;
  /** End the stream. Idempotent; also clears the keep-alive timer. */
  close(): void;
  /** True once the stream closed or the client disconnected. */
  readonly closed: boolean;
  /**
   * Remaining capacity in the response stream's internal queue, straight from
   * `ReadableStreamDefaultController.desiredSize`: positive while the consumer
   * keeps up, zero or negative once sent messages sit unread (each unread
   * message lowers it by one), `null` after the stream closed. `send()` never
   * applies backpressure — a stalled consumer buffers without bound — so a
   * producer pushing serious volume should check this and pause or drop when
   * it goes negative.
   */
  readonly desiredSize: number | null;
}

/**
 * Matches every line break the SSE parser recognizes (CRLF, CR, LF), so a
 * multi-line payload round-trips: the client's EventSource joins consecutive
 * `data:` lines with `\n`.
 */
const SSE_LINE_BREAK_RE = /\r\n|\r|\n/;

function assertSafeSseField(field: "event" | "id", value: string): void {
  // A CR or LF inside `event:`/`id:` would terminate the field early and turn
  // the remainder into attacker-controlled protocol lines — the SSE analogue
  // of header response-splitting. `id` additionally must not contain NUL:
  // the spec makes receivers ignore such ids, so it can only be a mistake.
  if (/[\r\n]/.test(value) || (field === "id" && value.includes("\0"))) {
    throw new Error(`Refused to serialize SSE "${field}" field containing CR, LF, or NUL`);
  }
}

/**
 * Serialize one message into its SSE wire format. Exported for tests and for
 * code that manages its own stream but wants the framing exactly right.
 */
export function serializeEventStreamMessage(message: EventStreamMessage): string {
  let out = "";

  if (message.event !== undefined) {
    assertSafeSseField("event", message.event);
    out += `event: ${message.event}\n`;
  }
  if (message.id !== undefined) {
    assertSafeSseField("id", message.id);
    out += `id: ${message.id}\n`;
  }
  if (message.retry !== undefined) {
    if (!Number.isInteger(message.retry) || message.retry < 0) {
      throw new Error(`SSE "retry" must be a non-negative integer of milliseconds`);
    }
    out += `retry: ${message.retry}\n`;
  }

  const text =
    typeof message.data === "string"
      ? message.data
      : // `JSON.stringify` yields `undefined` for `undefined`, functions, and
        // symbols; an empty `data:` line still dispatches the event.
        (JSON.stringify(message.data) ?? "");
  for (const line of text.split(SSE_LINE_BREAK_RE)) {
    out += `data: ${line}\n`;
  }

  return `${out}\n`;
}

/**
 * Create a Server-Sent Events stream for an API route handler.
 *
 * ```ts
 * export function GET({ request }: BaseRouteArgs) {
 *   const stream = createEventStream(request, { keepAlive: 15 });
 *   const timer = setInterval(() => {
 *     if (!stream.send({ data: { now: Date.now() } })) clearInterval(timer);
 *   }, 1000);
 *   return stream.response;
 * }
 * ```
 *
 * Built on the web `ReadableStream`, so it behaves identically on Node,
 * Cloudflare Workers, and Vercel Edge. Cleanup is wired to both disconnect
 * signals a runtime can deliver: `request.signal` aborting (workerd, edge)
 * and the response stream being cancelled (the Node adapter destroys the
 * piped stream when the client hangs up). Either one closes the stream,
 * clears the keep-alive timer, and makes `send()` return `false`.
 *
 * The response carries `Cache-Control: no-store, no-transform` so shared
 * caches never buffer or store it and compression/transforming proxies leave
 * the framing alone, plus `X-Accel-Buffering: no` for nginx-style reverse
 * proxies that buffer streamed responses by default.
 */
export function createEventStream(request: Request, init: EventStreamInit = {}): EventStream {
  if (init.keepAlive !== undefined && !(Number.isFinite(init.keepAlive) && init.keepAlive > 0)) {
    throw new Error(`createEventStream keepAlive must be a positive number of seconds`);
  }

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  // Shared teardown for every close path. Does not touch the controller:
  // after a cancel or an errored stream there is nothing left to close.
  function markClosed(): void {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    request.signal.removeEventListener("abort", onAbort);
  }

  function close(): void {
    if (closed) return;
    markClosed();
    try {
      controller?.close();
    } catch {
      // The stream already errored or the runtime closed it first.
    }
  }

  function onAbort(): void {
    close();
  }

  function enqueue(text: string): boolean {
    if (closed || controller === null) return false;
    try {
      controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      // The consumer is gone but `cancel()` has not fired (or fired between
      // the check above and the enqueue). Treat it as a disconnect.
      markClosed();
      return false;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // The client went away: the Node adapter destroys the piped stream on
      // response close and workerd cancels it directly.
      markClosed();
    },
  });

  if (init.keepAlive !== undefined && !request.signal.aborted) {
    heartbeat = setInterval(() => {
      enqueue(":keep-alive\n\n");
    }, init.keepAlive * 1000);
    // On Node an interval holds the event loop open. The client's socket
    // already keeps the process alive while anyone is listening, so the timer
    // itself must not: an un-consumed stream (or one torn down after
    // `server.close()`) would otherwise pin the process forever. A no-op on
    // runtimes where `setInterval` returns a number.
    (heartbeat as unknown as { unref?: () => void }).unref?.();
  }

  if (request.signal.aborted) {
    close();
  } else {
    request.signal.addEventListener("abort", onAbort, { once: true });
  }

  const headers = new Headers({
    "cache-control": "no-store, no-transform",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  if (init.headers) {
    applyHeaders(headers, init.headers);
  }

  return {
    response: new Response(stream, { headers, status: 200 }),
    send(message: EventStreamMessage): boolean {
      // Serialize before the closed check so field-injection mistakes throw
      // loudly even on a stream that already ended.
      const serialized = serializeEventStreamMessage(message);
      return enqueue(serialized);
    },
    close,
    get closed(): boolean {
      return closed;
    },
    get desiredSize(): number | null {
      if (closed || controller === null) return null;
      try {
        return controller.desiredSize;
      } catch {
        // The runtime released the controller (errored stream).
        return null;
      }
    },
  };
}
