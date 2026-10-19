// @vitest-environment jsdom
import { h, render } from "preact";
import { useEffect } from "preact/hooks";
import { expect, it } from "vitest";

// The root vitest.setup.ts keeps Preact's after-paint timer from throwing into
// a torn-down DOM environment ("cancelAnimationFrame is not defined").
it("unmounts a tree with an effect, then the environment goes away", async () => {
  // A paint that never comes, as under load: only Preact's timer fallback runs.
  globalThis.requestAnimationFrame = () => 0;
  const root = document.createElement("div");
  document.body.appendChild(root);
  function Effectful() {
    useEffect(() => () => {}, []);
    return h("p", null, "x");
  }
  render(h(Effectful, null), root);
  render(null, root);
  // What jsdom's teardown does to the globals while Preact's timer is pending.
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(root.textContent).toBe("");
});
