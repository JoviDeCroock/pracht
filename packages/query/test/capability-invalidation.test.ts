// @vitest-environment jsdom
import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryRoot } from "../src/index.ts";

function settle(detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(CAPABILITY_SETTLED_EVENT, { detail }));
}

describe("query invalidation after capability calls", () => {
  const container = document.createElement("div");

  afterEach(() => {
    render(null, container);
  });

  function mount(options?: Parameters<typeof createQueryRoot>[0]) {
    const root = createQueryRoot(options);
    const state = root.setup({ request: undefined, isServer: false });
    const invalidate = vi.spyOn(state.queryClient, "invalidateQueries");
    act(() => {
      render(h(root.Root, { state, children: h("p", null, "child") }), container);
    });
    return invalidate;
  }

  it("invalidates after a successful non-read call", () => {
    const invalidate = mount();
    settle({ name: "notes.create", effect: "write", ok: true });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe("<p>child</p>");
  });

  it("ignores reads, failures, and calls that opted out", () => {
    const invalidate = mount();
    settle({ name: "notes.search", effect: "read", ok: true });
    settle({ name: "notes.create", effect: "write", ok: false });
    settle({ name: "notes.create", effect: "write", ok: true, revalidate: false });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("can be switched off", () => {
    const invalidate = mount({ invalidateOnCapability: false });
    settle({ name: "notes.create", effect: "write", ok: true });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
