import { defineCommand, runMain } from "citty";

import { VERSION } from "./constants.js";

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
    generate: () => import("./commands/generate.js").then((m) => m.default),
    inspect: () => import("./commands/inspect.js").then((m) => m.default),
    verify: () => import("./commands/verify.js").then((m) => m.default),
  },
});

runMain(main);
