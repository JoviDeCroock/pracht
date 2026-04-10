import { defineCommand, runMain } from "citty";

import { VERSION } from "./constants.js";
import { buildCommand } from "./commands/build.js";
import { devCommand } from "./commands/dev.js";
import { doctorCommand } from "./commands/doctor.js";
import { generateCommand } from "./commands/generate.js";
import { inspectCommand } from "./commands/inspect.js";
import { verifyCommand } from "./commands/verify.js";

const main = defineCommand({
  meta: {
    name: "pracht",
    version: VERSION,
    description: "The Pracht framework CLI",
  },
  subCommands: {
    build: buildCommand,
    dev: devCommand,
    doctor: doctorCommand,
    generate: generateCommand,
    inspect: inspectCommand,
    verify: verifyCommand,
  },
});

runMain(main);
