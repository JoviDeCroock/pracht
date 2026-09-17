// @vitest-environment jsdom
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hydrateIslands } from "../src/islands-client.ts";
import { _resetHydrationMismatchForTesting } from "../src/hydration-mismatch.ts";

const BANNER_ID = "__pracht_hydration_mismatch__";

function mountIsland(serverHtml: string): void {
  document.body.innerHTML = `<pracht-island island="/src/islands/Widget.tsx">${serverHtml}</pracht-island>`;
}

describe("hydrateIslands diagnostics", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    _resetHydrationMismatchForTesting();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    _resetHydrationMismatchForTesting();
  });

  it("warns when an island's markup does not match what the component renders", async () => {
    mountIsland("<span>server</span>");

    function Widget() {
      return h("div", null, "client");
    }

    await hydrateIslands({
      modules: { "/src/islands/Widget.tsx": async () => ({ default: Widget }) },
    });

    const banner = document.getElementById(BANNER_ID);
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("<div>");
    expect(banner?.textContent).toContain("Hydration mismatch");
  });

  it("stays silent when the island's markup matches", async () => {
    mountIsland("<div>same</div>");

    function Widget() {
      return h("div", null, "same");
    }

    await hydrateIslands({
      modules: { "/src/islands/Widget.tsx": async () => ({ default: Widget }) },
    });

    expect(document.getElementById(BANNER_ID)).toBeNull();
  });
});
