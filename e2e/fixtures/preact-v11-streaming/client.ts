import { h, hydrate } from "preact";

import { createExperimentApp, createHeadBodyApp, createShellHeadApp } from "./app.mjs";

const params = new URL(import.meta.url).searchParams;
const rawMode = params.get("mode");
const mode =
  rawMode === "hydration-2" || rawMode === "head-body" || rawMode === "shell-head"
    ? rawMode
    : "stream";
const clientDelay = Number(params.get("clientDelay") ?? 0);

if (mode === "head-body" || mode === "shell-head") {
  // The whole document is Preact-owned, so hydration targets
  // `document.documentElement` and the app renders `<head>` and `<body>` as
  // siblings.
  const createApp = mode === "head-body" ? createHeadBodyApp : createShellHeadApp;
  const Document = createApp({
    bodyDelay: 0,
    clientDelay,
    headDelay: 0,
    mode,
    serverDelay: 0,
  });
  hydrate(h(Document, null), document.documentElement);
} else {
  const root = document.getElementById("experiment-root");

  if (!root) {
    throw new Error("The Preact v11 experiment root is missing.");
  }

  const App = createExperimentApp({ clientDelay, mode, serverDelay: 0 });
  hydrate(h(App, null), root);
}
