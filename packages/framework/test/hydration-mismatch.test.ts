// @vitest-environment jsdom
import { h, hydrate, options as preactOptions, render } from "preact";
import type { VNode } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetHydrationMismatchForTesting,
  installHydrationMismatchWarning,
} from "../src/hydration-mismatch.ts";

const BANNER_ID = "__pracht_hydration_mismatch__";

describe("installHydrationMismatchWarning", () => {
  let scratch: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    scratch = document.createElement("div");
    document.body.appendChild(scratch);
    _resetHydrationMismatchForTesting();
  });

  afterEach(() => {
    if (scratch.isConnected) {
      render(null, scratch);
      scratch.remove();
    }
    _resetHydrationMismatchForTesting();
  });

  it("appends a visible banner with the component name when Preact reports a hydration mismatch", () => {
    installHydrationMismatchWarning();

    function Profile() {
      return h("span", null, "client");
    }

    const vnode = h(Profile, null) as unknown as VNode;
    (preactOptions as { __m?: (vnode: VNode) => void }).__m!(vnode);

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Profile");
    expect(banner!.textContent).toContain("Hydration mismatch");
    expect(banner!.getAttribute("role")).toBe("alert");
  });

  it("chains to a previously installed __m hook", () => {
    const calls: VNode[] = [];
    (preactOptions as { __m?: (vnode: VNode) => void }).__m = (vnode) => {
      calls.push(vnode);
    };

    installHydrationMismatchWarning();

    const vnode = h("div", null) as unknown as VNode;
    (preactOptions as { __m?: (vnode: VNode) => void }).__m!(vnode);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(vnode);
    expect(document.getElementById(BANNER_ID)).not.toBeNull();
  });

  it("only installs the hook once across repeated calls", () => {
    installHydrationMismatchWarning();
    const firstHook = (preactOptions as { __m?: (vnode: VNode) => void }).__m;

    installHydrationMismatchWarning();
    const secondHook = (preactOptions as { __m?: (vnode: VNode) => void }).__m;

    expect(secondHook).toBe(firstHook);
  });

  it("appends additional mismatches as list items in the existing banner", () => {
    installHydrationMismatchWarning();

    const m = (preactOptions as { __m?: (vnode: VNode) => void }).__m!;
    m(h("div", null) as unknown as VNode);
    m(h("span", null) as unknown as VNode);

    const banner = document.getElementById(BANNER_ID)!;
    const items = banner.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("div");
    expect(items[1].textContent).toContain("span");
  });

  it("surfaces the banner on a real hydration mismatch", () => {
    installHydrationMismatchWarning();

    scratch.innerHTML = "<section>server</section>";

    function App() {
      return h("article", null, "client");
    }

    hydrate(h(App, null), scratch);

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Hydration mismatch");
  });
});
