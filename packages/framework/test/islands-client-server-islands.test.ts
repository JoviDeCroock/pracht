// @vitest-environment jsdom
import { h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hydrateIslands } from "../src/islands-client.ts";
import { startServerIslands } from "../src/server-islands-client.ts";
import { SERVER_ISLAND_SWAP_EVENT } from "../src/server-islands-shared.ts";

// How the islands bootstrap and the server island swap script meet: islands a
// server island swap brings in, and server islands an island's children hold.
// Its own file: the bootstrap binds its listeners once per page, with the
// options of the first `hydrateIslands()` call.

const SERVER_ISLAND = "/src/server-islands/Visitor.tsx";

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

let show: (open: boolean) => void = () => {};

function Closed({ children }: { children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  show = setOpen;
  return h("div", { id: "closed" }, open ? children : null);
}

function Counter() {
  return h("button", null, "hydrated");
}

let resolveCounter: () => void = () => {};
const counterImporter = vi.fn(
  () =>
    new Promise<unknown>((resolve) => {
      resolveCounter = () => resolve({ default: Counter });
    }),
);
const modules = {
  "/src/islands/Counter.tsx": counterImporter,
  "/src/islands/Closed.tsx": async () => ({ default: Closed }),
};

afterEach(() => {
  for (const island of document.querySelectorAll("pracht-island")) render(null, island);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("islands and server islands together", () => {
  it("hydrates an island once when a server island swap and the page scan both find it", async () => {
    document.body.innerHTML =
      '<div id="swapped"><pracht-island island="/src/islands/Counter.tsx" props="{}">' +
      "<button>static</button></pracht-island></div>";

    const hydrated = hydrateIslands({ modules });
    await vi.waitFor(() => expect(counterImporter).toHaveBeenCalledTimes(1));
    // A swap lands while the page scan's import of the island is in flight.
    document
      .getElementById("swapped")!
      .dispatchEvent(new Event(SERVER_ISLAND_SWAP_EVENT, { bubbles: true }));
    resolveCounter();
    await hydrated;
    await flush();

    expect(counterImporter).toHaveBeenCalledTimes(1);
    expect(document.querySelector("pracht-island")!.getAttribute("data-hydrated")).toBe("true");
    expect(document.querySelector("button")!.textContent).toBe("hydrated");
  });

  it("fetches a server island in unplaced children when the island first shows them", async () => {
    vi.stubGlobal("navigation", new EventTarget());
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        calls.push(new URL(input, "http://localhost").searchParams.get("island")!);
        return new Response("<p>Hi, Ada</p>", {
          status: 200,
          headers: { "content-type": "text/html", "x-pracht-server-island": "1" },
        });
      }),
    );
    // What the server renders for an island that does not place its children.
    document.body.innerHTML =
      '<pracht-island island="/src/islands/Closed.tsx" props="{}"><div id="closed"></div>' +
      `<template pracht-slot><pracht-server-island island="${SERVER_ISLAND}" pending>` +
      "<i>loading</i></pracht-server-island><!--/pracht-slot--></template></pracht-island>";

    await hydrateIslands({ modules });
    startServerIslands();
    await flush();
    // Inert in the <template>: nothing to fetch yet.
    expect(calls).toEqual([]);

    show(true);
    await flush();
    expect(calls).toEqual([SERVER_ISLAND]);
    expect(document.querySelector("pracht-server-island")!.innerHTML).toBe("<p>Hi, Ada</p>");

    // Shown again later, the filled HTML moves back in without a refetch.
    show(false);
    await flush();
    show(true);
    await flush();
    expect(calls).toEqual([SERVER_ISLAND]);
    expect(document.querySelector("pracht-server-island")!.innerHTML).toBe("<p>Hi, Ada</p>");
  });
});
