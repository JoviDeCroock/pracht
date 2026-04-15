// @vitest-environment jsdom
import { Component, h, render } from "preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PrachtRuntimeProvider, useLocation } from "../src/index.ts";

let scratch: HTMLDivElement;

function setupScratch() {
  scratch = document.createElement("div");
  document.body.appendChild(scratch);
  return scratch;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}

class Blocker extends Component<{ children: ComponentChildren }> {
  shouldComponentUpdate() {
    return false;
  }

  render(props: { children: ComponentChildren }) {
    return props.children;
  }
}

describe("PrachtRuntimeProvider", () => {
  beforeEach(() => {
    setupScratch();
  });

  afterEach(() => {
    render(null, scratch);
    scratch.remove();
  });

  it("does not fan out a new context value when params are omitted and route state is unchanged", async () => {
    let bump!: () => void;
    let consumerRenders = 0;

    function Consumer() {
      consumerRenders += 1;
      useLocation();
      return null;
    }

    function App() {
      const [, setTick] = useState(0);
      bump = () => setTick((tick) => tick + 1);

      return h(PrachtRuntimeProvider, {
        children: h(Blocker, null, h(Consumer, null)),
        data: { user: "Ada" },
        routeId: "dashboard",
        url: "/dashboard",
      });
    }

    render(h(App, null), scratch);
    expect(consumerRenders).toBe(1);

    bump();
    await flush();

    expect(consumerRenders).toBe(1);
  });
});
