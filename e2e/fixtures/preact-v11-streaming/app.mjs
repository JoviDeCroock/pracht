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

function HeadContent() {
  useEffect(() => {
    document.documentElement.setAttribute("data-head-boundary-hydrated", "true");
  }, []);
  return h(
    Fragment,
    null,
    h("title", null, "resolved title"),
    h("meta", { name: "description", content: "resolved description" }),
    h("link", { rel: "canonical", href: "/canonical" }),
  );
}

function HeadBodyContent() {
  const [count, setCount] = useState(0);
  return h(
    BoundaryReady,
    { name: "head-body-boundary" },
    h(
      "button",
      {
        id: "head-body-button",
        onClick: () => setCount((value) => value + 1),
      },
      `head-body count: ${count}`,
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

function clientEntrySrc(config) {
  return `/client.ts?mode=${config.mode}&clientDelay=${config.clientDelay}`;
}

/**
 * The head/body mode owns the whole document so Preact — not a hand-written
 * shell — is responsible for both `<head>` and `<body>`. That is the only way
 * a `<head>` Suspense boundary can be hydrated rather than merely patched in
 * by the stream's `<preact-island>` custom element.
 */
export function createHeadBodyApp(config) {
  const isServer = typeof window === "undefined";
  const headDelay = isServer ? config.headDelay : config.clientDelay;
  const bodyDelay = isServer ? config.bodyDelay : config.clientDelay;
  const LazyHeadContent = lazyAfter(HeadContent, headDelay);
  const LazyBodyContent = lazyAfter(HeadBodyContent, bodyDelay);

  return function HeadBodyDocument() {
    useEffect(() => {
      document.documentElement.setAttribute("data-root-hydrated", "true");
    }, []);

    return h(
      Fragment,
      null,
      h(
        "head",
        null,
        h("meta", { charSet: "utf-8" }),
        h(Suspense, { fallback: h("title", null, "loading title") }, h(LazyHeadContent)),
      ),
      h(
        "body",
        null,
        h(
          "main",
          { id: "head-body-experiment" },
          h("h1", null, "Preact v11 head and body streaming"),
          h(
            Suspense,
            { fallback: h("p", { id: "head-body-fallback" }, "body fallback") },
            h(LazyBodyContent),
          ),
          h("p", { id: "head-body-sibling" }, "stable sibling"),
        ),
        h("script", { type: "module", src: clientEntrySrc(config) }),
      ),
    );
  };
}

/**
 * The recommended shape: `<head>` is fully resolved in the synchronous shell so
 * it lands complete in the first flush, and only `<body>` suspends. Preact
 * still owns the whole document, so head content stays hydrated and
 * client-updatable — it just never depends on the stream's patcher script.
 */
export function createShellHeadApp(config) {
  const isServer = typeof window === "undefined";
  const bodyDelay = isServer ? config.bodyDelay : config.clientDelay;
  const LazyBodyContent = lazyAfter(HeadBodyContent, bodyDelay);

  return function ShellHeadDocument() {
    useEffect(() => {
      document.documentElement.setAttribute("data-root-hydrated", "true");
    }, []);

    return h(
      Fragment,
      null,
      h(
        "head",
        null,
        h("meta", { charSet: "utf-8" }),
        h("title", null, "shell title"),
        h("meta", { name: "description", content: "shell description" }),
        h("link", { rel: "canonical", href: "/canonical" }),
      ),
      h(
        "body",
        null,
        h(
          "main",
          { id: "head-body-experiment" },
          h("h1", null, "Preact v11 shell head with streamed body"),
          h(
            Suspense,
            { fallback: h("p", { id: "head-body-fallback" }, "body fallback") },
            h(LazyBodyContent),
          ),
          h("p", { id: "head-body-sibling" }, "stable sibling"),
        ),
        h("script", { type: "module", src: clientEntrySrc(config) }),
      ),
    );
  };
}

export function createDocument(config) {
  if (config.mode === "head-body") {
    return h("html", { lang: "en" }, h(createHeadBodyApp(config)));
  }

  if (config.mode === "shell-head") {
    return h("html", { lang: "en" }, h(createShellHeadApp(config)));
  }

  const App = createExperimentApp(config);
  return h(
    "html",
    { lang: "en" },
    h("head", null, h("meta", { charSet: "utf-8" }), h("title", null, "Preact v11 SSR experiment")),
    h(
      "body",
      null,
      h("div", { id: "experiment-root" }, h(App)),
      h("script", { type: "module", src: clientEntrySrc(config) }),
    ),
  );
}
