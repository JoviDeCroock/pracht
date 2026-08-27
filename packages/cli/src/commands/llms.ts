import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";

import { AUTHORING_GUIDE } from "../authoring-guide.js";
import { readProjectConfig } from "../project.js";

/**
 * Two different documents are called `llms.txt` in a pracht app:
 *
 * - this one — the framework's authoring guide, written for a coding agent
 *   *editing* the app;
 * - the one the vite plugin's `llmsTxt` option generates into
 *   `dist/client/llms.txt` and serves at `/llms.txt` — the app's own index,
 *   written for an agent *using* the deployed site.
 *
 * Writing the first into the project root next to a project that publishes the
 * second is a genuine trap, so `--write` says so and `--out` exists to put the
 * guide somewhere unambiguous.
 */
const DEFAULT_OUTPUT = "llms.txt";

export default defineCommand({
  meta: {
    name: "llms",
    description: "Print the pracht authoring guide for coding agents",
  },
  args: {
    write: {
      type: "boolean",
      description: `Write the guide to ${DEFAULT_OUTPUT} in the app root`,
    },
    out: {
      type: "string",
      description: `Write the guide to a specific path (implies --write; default ${DEFAULT_OUTPUT})`,
    },
  },
  async run({ args }) {
    const outPath = typeof args.out === "string" && args.out !== "" ? args.out : undefined;
    if (!args.write && !outPath) {
      console.log(AUTHORING_GUIDE);
      return;
    }

    const target = outPath ?? DEFAULT_OUTPUT;
    const filePath = resolve(process.cwd(), target);
    writeFileSync(filePath, AUTHORING_GUIDE, "utf-8");
    console.log(`Wrote ${target}. Agents working in this app will pick up the conventions.`);

    if (outPath === undefined && projectPublishesItsOwnLlmsTxt()) {
      console.log(
        "\nNote: this app also generates a different llms.txt — its own agent-facing\n" +
          "index — into dist/client/llms.txt via the plugin's `llmsTxt` option. The file\n" +
          "just written is the framework authoring guide, not that index. Use\n" +
          "`pracht llms --out AGENTS-pracht.md` to avoid the name collision.",
      );
    }
  },
});

/** Whether the app enables the vite plugin's `llmsTxt` option. */
function projectPublishesItsOwnLlmsTxt(root: string = process.cwd()): boolean {
  try {
    const project = readProjectConfig(root);
    if (!project.configFile) return false;
    const source = readFileSync(project.configFile, "utf-8");
    // A text probe, matching how the rest of the CLI reads the vite config
    // without evaluating it. A false negative only costs the extra note.
    return /\bllmsTxt\s*:/.test(source) && !/\bllmsTxt\s*:\s*false\b/.test(source);
  } catch {
    return false;
  }
}

export { DEFAULT_OUTPUT as LLMS_GUIDE_DEFAULT_OUTPUT, projectPublishesItsOwnLlmsTxt };
