// @vitest-environment jsdom
import { h } from "preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it } from "vitest";

import { hydrateIslands } from "../src/islands-client.ts";

function Counter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);
  return h("button", { id: "count", onClick: () => setCount((c) => c + 1) }, String(count));
}

function Toggle({
  open: initial = true,
  children,
}: {
  open?: boolean;
  children?: ComponentChildren;
}) {
  const [open, setOpen] = useState(initial);
  return h(
    "div",
    null,
    h("button", { id: "toggle", onClick: () => setOpen((o) => !o) }, open ? "Hide" : "Show"),
    open ? children : null,
  );
}

const modules = {
  "/src/islands/Toggle.tsx": async () => ({ default: Toggle }),
  "/src/islands/Counter.tsx": async () => ({ default: Counter }),
};

const counterIsland =
  '<pracht-island island="/src/islands/Counter.tsx" props="{&quot;start&quot;:2}" style="display:contents"><button id="count">2</button></pracht-island>';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function click(id: string): Promise<void> {
  document.getElementById(id)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return tick();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("island children", () => {
  it("hydrates around the server-rendered children without touching them", async () => {
    document.body.innerHTML =
      '<pracht-island island="/src/islands/Toggle.tsx" style="display:contents"><div><button id="toggle">Hide</button>' +
      '<pracht-slot style="display:contents"><p id="content">server <b>content</b></p></pracht-slot></div></pracht-island>';
    const content = document.getElementById("content");

    await hydrateIslands({ modules });

    expect(document.getElementById("content")).toBe(content);
    expect(content!.innerHTML).toBe("server <b>content</b>");

    await click("toggle");
    expect(document.getElementById("content")).toBeNull();
    expect(document.getElementById("toggle")!.textContent).toBe("Show");

    await click("toggle");
    expect(document.getElementById("content")).toBe(content);
    expect(document.querySelector<HTMLElement>("pracht-slot")!.style.display).toBe("contents");
  });

  it("keeps an island inside the children hydrated and stateful across a re-mount", async () => {
    document.body.innerHTML =
      '<pracht-island island="/src/islands/Toggle.tsx" style="display:contents"><div><button id="toggle">Hide</button>' +
      `<pracht-slot style="display:contents">${counterIsland}</pracht-slot></div></pracht-island>`;

    await hydrateIslands({ modules });
    expect(document.querySelectorAll('[data-hydrated="true"]')).toHaveLength(2);

    await click("count");
    expect(document.getElementById("count")!.textContent).toBe("3");

    await click("toggle");
    await click("toggle");
    expect(document.getElementById("count")!.textContent).toBe("3");
    await click("count");
    expect(document.getElementById("count")!.textContent).toBe("4");
  });

  it("shows children the island did not place on the server once it renders them", async () => {
    document.body.innerHTML =
      '<pracht-island island="/src/islands/Toggle.tsx" props="{&quot;open&quot;:false}" style="display:contents"><div><button id="toggle">Show</button></div>' +
      `<template pracht-slot><p id="content">later</p>${counterIsland}</template></pracht-island>`;

    await hydrateIslands({ modules });
    expect(document.querySelector("template")).toBeNull();
    expect(document.getElementById("content")).toBeNull();

    await click("toggle");
    expect(document.getElementById("content")!.textContent).toBe("later");

    // The island inside the template was inert until now; it hydrates on show.
    await tick();
    await click("count");
    expect(document.getElementById("count")!.textContent).toBe("3");
  });

  it("leaves slots owned by a nested island to that island", async () => {
    document.body.innerHTML =
      '<pracht-island island="/src/islands/Toggle.tsx" style="display:contents"><div><button id="toggle">Hide</button>' +
      '<pracht-slot style="display:contents">' +
      '<pracht-island island="/src/islands/Toggle.tsx" style="display:contents"><div><button id="inner">Hide</button>' +
      '<pracht-slot style="display:contents"><p id="inner-content">inner</p></pracht-slot></div></pracht-island>' +
      "</pracht-slot></div></pracht-island>";
    const inner = document.getElementById("inner-content");

    await hydrateIslands({ modules });

    await click("toggle");
    await click("toggle");
    expect(document.getElementById("inner-content")).toBe(inner);
    expect(document.querySelectorAll("pracht-slot")).toHaveLength(2);
  });
});
