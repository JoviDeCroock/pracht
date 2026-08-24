// @vitest-environment jsdom
import { h, render } from "preact";
import { Suspense } from "preact-suspense";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "../src/error-boundary.ts";

/**
 * Preact re-renders a boundary through `setState`, which is batched, so the
 * fallback appears on the next tick rather than during the throwing render.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ErrorBoundary", () => {
  it("renders its children until one of them throws", () => {
    const scratch = document.createElement("div");
    render(
      h(ErrorBoundary, { fallback: h("p", null, "broken") }, h("span", null, "fine")),
      scratch,
    );

    expect(scratch.innerHTML).toBe("<span>fine</span>");
  });

  it("replaces the subtree with the fallback and reports the error once", async () => {
    const scratch = document.createElement("div");
    const onError = vi.fn();
    const Boom = () => {
      throw new Error("kaboom");
    };

    render(h(ErrorBoundary, { onError, fallback: h("p", null, "broken") }, h(Boom, null)), scratch);

    await flush();
    expect(scratch.innerHTML).toBe("<p>broken</p>");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe("kaboom");
  });

  it("passes the error and a retry callback to a function fallback", async () => {
    const scratch = document.createElement("div");
    let fail = true;
    let retry: (() => void) | undefined;
    const Flaky = () => {
      if (fail) throw new Error("not yet");
      return h("span", null, "recovered");
    };

    render(
      h(
        ErrorBoundary,
        {
          fallback: (error: Error, retryFn: () => void) => {
            retry = retryFn;
            return h("p", null, error.message);
          },
        },
        h(Flaky, null),
      ),
      scratch,
    );
    await flush();
    expect(scratch.innerHTML).toBe("<p>not yet</p>");

    fail = false;
    retry?.();
    await flush();
    expect(scratch.innerHTML).toBe("<span>recovered</span>");
  });

  it("declines thrown promises so an outer Suspense still handles them", async () => {
    const scratch = document.createElement("div");
    const onError = vi.fn();
    let resolved = false;
    const pending = Promise.resolve().then(() => {
      resolved = true;
    });
    const Suspending = () => {
      if (!resolved) throw pending;
      return h("span", null, "loaded");
    };

    render(
      h(
        Suspense as never,
        { fallback: h("p", null, "loading") },
        h(ErrorBoundary, { fallback: h("p", null, "broken") }, h(Suspending, null)),
      ),
      scratch,
    );

    await pending;
    await flush();
    // The suspension reached `Suspense`, not the boundary: had the boundary
    // treated the promise as a failure, this would read "broken".
    expect(scratch.innerHTML).toBe("<span>loaded</span>");
    expect(onError).not.toHaveBeenCalled();
  });
});
