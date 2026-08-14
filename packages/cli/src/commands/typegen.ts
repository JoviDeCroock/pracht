import { defineCommand } from "citty";

import {
  DEFAULT_CAPABILITIES_OUT,
  DEFAULT_DECLARATION_OUT,
  DEFAULT_RUNTIME_OUT,
  runTypegen,
} from "../typegen.js";
import { handleCliError } from "../utils.js";

export default defineCommand({
  meta: {
    name: "typegen",
    description: "Generate typed route declarations and href helpers",
  },
  args: {
    out: {
      type: "string",
      description: `Declaration output path (default: ${DEFAULT_DECLARATION_OUT})`,
    },
    "runtime-out": {
      type: "string",
      description: `Runtime href helper output path (default: ${DEFAULT_RUNTIME_OUT})`,
    },
    "capabilities-out": {
      type: "string",
      description: `Capability declaration output path (default: ${DEFAULT_CAPABILITIES_OUT})`,
    },
    check: {
      type: "boolean",
      description: "Check whether generated route files are up to date without writing",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const json = Boolean(args.json);
    try {
      const result = await runTypegen({
        capabilitiesOut:
          typeof args["capabilities-out"] === "string"
            ? args["capabilities-out"]
            : DEFAULT_CAPABILITIES_OUT,
        check: Boolean(args.check),
        declarationOut: typeof args.out === "string" ? args.out : DEFAULT_DECLARATION_OUT,
        root: process.cwd(),
        runtimeOut:
          typeof args["runtime-out"] === "string" ? args["runtime-out"] : DEFAULT_RUNTIME_OUT,
      });

      if (json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        return;
      }

      if (result.check) {
        console.log("Generated route files are up to date.");
        return;
      }

      console.log("Generated typed routes:");
      for (const file of result.files) {
        console.log(`  ${file}`);
      }
    } catch (error) {
      handleCliError(error, { json });
    }
  },
});
