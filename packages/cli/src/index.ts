import { defineCommand, runMain } from "citty";

import { VERSION } from "./constants.js";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

const main = defineCommand({
  meta: {
    name: "pracht",
    version: VERSION,
    description: "The pracht CLI",
  },
  subCommands: {
    build: () => import("./commands/build.js").then((m) => m.default),
    dev: () => import("./commands/dev.js").then((m) => m.default),
    doctor: () => import("./commands/doctor.js").then((m) => m.default),
    eval: () => import("./commands/eval.js").then((m) => m.default),
    generate: () => import("./commands/generate.js").then((m) => m.default),
    inspect: () => import("./commands/inspect.js").then((m) => m.default),
    llms: () => import("./commands/llms.js").then((m) => m.default),
    mcp: () => import("./commands/mcp.js").then((m) => m.default),
    plan: () => import("./commands/plan.js").then((m) => m.default),
    preview: () => import("./commands/preview.js").then((m) => m.default),
    report: () => import("./commands/report.js").then((m) => m.default),
    typegen: () => import("./commands/typegen.js").then((m) => m.default),
    verify: () => import("./commands/verify.js").then((m) => m.default),
  },
});

runMain(main);
