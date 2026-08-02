import { h, hydrate } from "preact";

import { createExperimentApp } from "./app.mjs";

const params = new URL(import.meta.url).searchParams;
const mode = params.get("mode") === "hydration-2" ? "hydration-2" : "stream";
const clientDelay = Number(params.get("clientDelay") ?? 0);
const root = document.getElementById("experiment-root");

if (!root) {
  throw new Error("The Preact v11 experiment root is missing.");
}

const App = createExperimentApp({ clientDelay, mode, serverDelay: 0 });
hydrate(h(App, null), root);
