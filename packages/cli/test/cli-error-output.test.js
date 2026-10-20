import { afterEach, describe, expect, it } from "vitest";

import { colorEnabled, terminalText } from "../src/utils.ts";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCliStatus,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

const ESC = String.fromCharCode(0x1b);
// The spawned CLI writes to pipes, never a terminal. FORCE_COLOR would make
// Vite colour its frames regardless, so the parent's setting is dropped.
const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...pipedEnv } = process.env;

function writeBrokenManifestApp(prefix, routesSource) {
  const appDir = createRepoTempDir(prefix);
  writeTypedManifestApp(appDir);
  writeProjectFile(appDir, "src/boom.ts", 'throw new Error("graph eval boom");\nexport {};\n');
  writeProjectFile(appDir, "src/routes.ts", routesSource);
  return appDir;
}

const THROWING_MANIFEST = `import { defineApp, route } from "@pracht/core";
import "./boom.ts";

export const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
`;

// A missing comma: Vite's parse error arrives with a coloured code frame.
const UNPARSEABLE_MANIFEST = `import { defineApp, route } from "@pracht/core";

export const app = defineApp({ routes: [route("/" "./routes/home.tsx")] });
`;

describe("@pracht/cli error output", () => {
  it("prints one JSON error object from inspect --json when the graph fails", () => {
    const appDir = writeBrokenManifestApp("pracht-cli-inspect-json-error-", THROWING_MANIFEST);

    const result = runCliStatus(["inspect", "all", "--json"], { cwd: appDir, env: pipedEnv });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: "graph eval boom" });
  }, 30_000);

  it("prints the message without a stack from inspect when the graph fails", () => {
    const appDir = writeBrokenManifestApp("pracht-cli-inspect-error-", THROWING_MANIFEST);

    const result = runCliStatus(["inspect", "routes"], { cwd: appDir, env: pipedEnv });

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("graph eval boom");
  }, 30_000);

  it("keeps escape codes out of piped verify, doctor, inspect and typegen errors", () => {
    const appDir = writeBrokenManifestApp("pracht-cli-error-ansi-", UNPARSEABLE_MANIFEST);

    for (const args of [
      ["verify"],
      ["verify", "--json"],
      ["doctor"],
      ["doctor", "--json"],
      ["inspect", "routes"],
      ["inspect", "routes", "--json"],
      ["typegen"],
      ["typegen", "--json"],
    ]) {
      const result = runCliStatus(args, { cwd: appDir, env: pipedEnv });
      expect(result.status, args.join(" ")).toBe(1);
      expect(`${result.stdout}${result.stderr}`, args.join(" ")).not.toContain(ESC);
    }

    const verify = runCliStatus(["verify", "--json"], { cwd: appDir, env: pipedEnv });
    expect(verify.stdout).toContain("PARSE_ERROR");
  }, 120_000);
});

describe("terminal colour", () => {
  const coloured = `${ESC}[31mred${ESC}[0m`;

  it("keeps colour for a terminal and strips it for a pipe", () => {
    const previous = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      expect(colorEnabled({ isTTY: true })).toBe(true);
      expect(terminalText(coloured, { isTTY: true })).toBe(coloured);
      expect(colorEnabled({ isTTY: false })).toBe(false);
      expect(terminalText(coloured, {})).toBe("red");
    } finally {
      if (previous !== undefined) process.env.NO_COLOR = previous;
    }
  });

  it("strips colour on a terminal when NO_COLOR is set", () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(colorEnabled({ isTTY: true })).toBe(false);
      expect(terminalText(coloured, { isTTY: true })).toBe("red");
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });
});
