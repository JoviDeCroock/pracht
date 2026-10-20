/**
 * One request's budget: the `AbortSignal` handed to middleware, loaders, API
 * route handlers, and capabilities, and the work that keeps its timer running.
 *
 * This is the only owner of request-scoped cancellation. `@pracht/core` makes
 * one per request and hands it to the capability dispatch it runs; a
 * standalone capability host makes one per request the same way. A second
 * signal per request would run a second, independent budget.
 *
 * Two independent reasons to stop the work are folded into one signal: the
 * server-side budget (`defineApp({ loaderTimeoutMs })`, 30 s by default) and
 * the client going away. Composing them is what makes `signal` worth passing
 * to `fetch()` or a database driver: a timeout alone keeps a request the
 * caller has already abandoned running to completion.
 *
 * The timer runs only while something can still use it: the pipeline until it
 * has produced a response, an app-built body until it is read, a streamed
 * document until it ends, each deferred field and `waitUntil` promise until it
 * settles. Each of those takes a `hold()`; when the last one is released the
 * timer is cleared. A pending timer keeps the signal and everything its
 * listeners close over reachable, so a timer left to run out would retain
 * every finished request for the whole budget.
 *
 * The signal is wired by hand rather than with the static `AbortSignal`
 * timeout and composition helpers: neither can be cancelled, and a composite
 * signal with an abort listener is kept alive until one of its sources aborts.
 * `request-budget-seam.test.ts` in `@pracht/core` bans them on request paths.
 */

import type { WaitUntil } from "../capability.ts";

export interface RequestBudget {
  /** The composed signal. Created, and its timer started, on first read. */
  readonly signal: AbortSignal;
  /** Keep the budget running until the returned function is called. */
  hold(): () => void;
  /** Abort the signal now, with `reason`. */
  abort(reason: unknown): void;
  /** Release the pipeline's own hold, once its response is produced. */
  release(): void;
  /** Whether a signal was handed out and its timer is still pending. */
  readonly timing: boolean;
}

const noop = () => {};

export function createRequestBudget(
  clientSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestBudget {
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The pipeline holds the budget from the start; it releases that hold
  // through `release()`.
  let holds = 1;
  const clear = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const drop = () => {
    if (holds > 0 && --holds === 0) clear();
  };
  const once = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      drop();
    };
  };

  const budget: RequestBudget = {
    get signal() {
      if (controller) return controller.signal;
      const own = (controller = new AbortController());
      if (clientSignal?.aborted) {
        own.abort(clientSignal.reason);
        return own.signal;
      }
      if (holds > 0) {
        timer = setTimeout(() => {
          timer = undefined;
          own.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        }, timeoutMs);
        // A budget must not keep a process alive on its own.
        (timer as { unref?: () => void }).unref?.();
      }
      if (clientSignal) {
        const onClientAbort = () => own.abort(clientSignal.reason);
        clientSignal.addEventListener("abort", onClientAbort, { once: true });
        own.signal.addEventListener(
          "abort",
          () => {
            clear();
            clientSignal.removeEventListener("abort", onClientAbort);
          },
          { once: true },
        );
      }
      return own.signal;
    },
    hold() {
      if (holds === 0) return noop;
      holds++;
      return once();
    },
    abort(reason) {
      const signal = budget.signal;
      clear();
      if (!signal.aborted) controller!.abort(reason);
    },
    release: once(),
    get timing() {
      return timer !== undefined;
    },
  };
  return budget;
}

/**
 * Whether a response with `status` leaves its budget running until it fires.
 *
 * A server error may have abandoned work that still reads the signal, such as
 * the sibling of a call that threw inside `Promise.all`, and nothing else
 * would ever stop it. A 4xx is a deliberate answer: the request was rejected
 * (bad input, wrong method, not found) or application code chose the status,
 * so it releases like a success and its finished state can be collected.
 */
export function failureKeepsBudget(status: number): boolean {
  return status >= 500;
}

/** `waitUntil` that keeps `budget` running until each registered task settles. */
export function holdingWaitUntil(
  budget: Pick<RequestBudget, "hold">,
  waitUntil: WaitUntil,
): WaitUntil {
  return (promise) => {
    const release = budget.hold();
    waitUntil(promise);
    void Promise.resolve(promise).then(release, release);
  };
}

/**
 * Hold `budget` until `response`'s body is read to the end, errors, or is
 * cancelled, so a stalled body an application built (a proxied upstream
 * stream) still times out. Returns the response to send: `response` itself
 * when it has no body to wait for, otherwise a copy whose body releases the
 * hold.
 */
export function holdUntilBodySettles(
  budget: Pick<RequestBudget, "hold">,
  response: Response,
): Response {
  const body = response.body;
  if (!body || response.status === 101 || (response as { webSocket?: unknown }).webSocket) {
    return response;
  }
  const release = budget.hold();
  const reader = body.getReader();
  const settled = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(settled, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Release the pipeline's hold on `budget` once `response` is out, and return
 * the response to send. Work that may still read the signal keeps the budget,
 * so its timeout still applies:
 *
 * - A server error keeps it until it fires (`failureKeepsBudget`).
 * - An app-built body holds it until it settles (`holdUntilBodySettles`).
 *   `framework` names bodies the host built itself, which are buffered or
 *   take their own hold, and are passed through untouched.
 *
 * Nothing is kept when no signal was handed out: there is no timer then.
 */
export function releaseBudgetWith(
  budget: RequestBudget,
  response: Response,
  framework?: (response: Response) => boolean,
): Response {
  if (!budget.timing) {
    budget.release();
    return response;
  }
  if (failureKeepsBudget(response.status)) return response;
  const settled = framework?.(response) ? response : holdUntilBodySettles(budget, response);
  budget.release();
  return settled;
}
