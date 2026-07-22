import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";

import { AUTHORING_GUIDE } from "../authoring-guide.js";

export default defineCommand({
  meta: {
    name: "llms",
    description: "Print the pracht authoring guide for coding agents",
  },
  args: {
    write: {
      type: "boolean",
      description: "Write the guide to llms.txt in the app root",
    },
  },
  async run({ args }) {
    if (args.write) {
      const filePath = resolve(process.cwd(), "llms.txt");
      writeFileSync(filePath, AUTHORING_GUIDE, "utf-8");
      console.log("Wrote llms.txt. Agents working in this app will pick up the conventions.");
      return;
    }

    console.log(AUTHORING_GUIDE);
  },
});
