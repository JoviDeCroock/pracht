// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Form } from "../src/runtime-hooks.ts";
import { _resetNavigationForTesting, getNavigation } from "../src/navigation-state.ts";

// The revalidation listener lives behind a dynamic import so a plain
// `<Form action=…>` page never pays for it. That chunk is fetched over the
// network, which means it can be missing: a tab left open across a deploy asks
// for a hash that no longer exists, and an offline page cannot ask at all.
vi.mock("../src/runtime-capability-revalidate.ts", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

function submit(root: HTMLElement): void {
  const form = root.querySelector("form")!;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("<Form capability> when the revalidation chunk cannot be loaded", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    _resetNavigationForTesting();
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetNavigationForTesting();
  });

  it("still submits and reports the envelope", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { id: 1 } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const results: unknown[] = [];

    render(
      h(Form, { capability: "notes.create", onCapabilityResult: (e: unknown) => results.push(e) }),
      root,
    );
    submit(root);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ ok: true, data: { id: 1 } }]);
  });

  it("reports a network_error envelope when the request also fails", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));
    const results: { ok: boolean; error?: { code: string } }[] = [];

    render(
      h(Form, {
        capability: "notes.create",
        onCapabilityResult: (envelope: unknown) =>
          results.push(envelope as { ok: boolean; error?: { code: string } }),
      }),
      root,
    );
    submit(root);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The submission must not be swallowed by an unhandled rejection from the
    // failed chunk import — the caller still hears back.
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error?.code).toBe("network_error");
  });

  it("shows the pending state on the frame the visitor submitted", () => {
    fetchSpy.mockReturnValue(new Promise(() => {}));

    render(h(Form, { capability: "notes.create" }), root);
    submit(root);

    // Synchronous: awaiting the chunk import before publishing this would
    // leave the button un-disabled until a network round trip finished.
    expect(getNavigation().state).toBe("submitting");
  });

  it("settles the pending state once the submission resolves", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
    );

    render(h(Form, { capability: "notes.create" }), root);
    submit(root);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getNavigation().state).toBe("idle");
  });
});
