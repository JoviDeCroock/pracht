import { Fragment, h } from "preact";
import { lazy, Suspense } from "preact/compat";
import { useEffect, useState } from "preact/hooks";

function after(delay, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), delay));
}

function BoundaryReady({ name, children }) {
  useEffect(() => {
    document.documentElement.setAttribute(`data-${name}-hydrated`, "true");
  }, [name]);
  return children;
}

function StreamedContent() {
  const [count, setCount] = useState(0);
  return h(
    BoundaryReady,
    { name: "stream-boundary" },
    h(
      "button",
      {
        id: "stream-button",
        onClick: () => setCount((value) => value + 1),
      },
      `stream count: ${count}`,
    ),
  );
}

function EmptyContent() {
  useEffect(() => {
    document.documentElement.setAttribute("data-empty-boundary-hydrated", "true");
  }, []);
  return null;
}

function MultipleContent() {
  const [count, setCount] = useState(0);
  return h(
    BoundaryReady,
    { name: "multiple-boundary" },
    h(
      Fragment,
      null,
      h(
        "button",
        {
          id: "multiple-first",
          onClick: () => setCount((value) => value + 1),
        },
        `multiple count: ${count}`,
      ),
      h("span", { id: "multiple-second" }, "second node"),
    ),
  );
}

function lazyAfter(Component, delay) {
  return lazy(() => after(delay, { default: Component }));
}

export function createExperimentApp({ clientDelay, mode, serverDelay }) {
  const delay = typeof window === "undefined" ? serverDelay : clientDelay;
  const LazyStreamedContent = lazyAfter(StreamedContent, delay);
  const LazyEmptyContent = lazyAfter(EmptyContent, delay);
  const LazyMultipleContent = lazyAfter(MultipleContent, delay);

  return function ExperimentApp() {
    useEffect(() => {
      document.documentElement.setAttribute("data-root-hydrated", "true");
    }, []);

    if (mode === "stream") {
      return h(
        "main",
        { id: "stream-experiment" },
        h("h1", null, "Preact v11 streamed hydration"),
        h(
          Suspense,
          { fallback: h("p", { id: "stream-fallback" }, "stream fallback") },
          h(LazyStreamedContent),
        ),
        h("p", { id: "stream-sibling" }, "stable sibling"),
      );
    }

    return h(
      "main",
      { id: "hydration-2-experiment" },
      h("h1", null, "Preact Hydration 2.0"),
      h(
        Suspense,
        { fallback: h("p", { id: "empty-fallback" }, "empty fallback") },
        h(LazyEmptyContent),
      ),
      h("p", { id: "after-empty" }, "sibling after empty boundary"),
      h(
        Suspense,
        { fallback: h("p", { id: "multiple-fallback" }, "multiple fallback") },
        h(LazyMultipleContent),
      ),
      h("p", { id: "after-multiple" }, "sibling after multiple boundary"),
    );
  };
}

export function createDocument(config) {
  const App = createExperimentApp(config);
  return h(
    "html",
    { lang: "en" },
    h("head", null, h("meta", { charSet: "utf-8" }), h("title", null, "Preact v11 SSR experiment")),
    h(
      "body",
      null,
      h("div", { id: "experiment-root" }, h(App)),
      h("script", {
        type: "module",
        src: `/client.ts?mode=${config.mode}&clientDelay=${config.clientDelay}`,
      }),
    ),
  );
}
