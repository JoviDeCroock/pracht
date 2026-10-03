import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDotEnvSync, loadDotEnvIntoProcess } from "../src/dotenv.ts";

const dirs: string[] = [];
const touchedKeys: string[] = [];

afterEach(() => {
  for (const key of touchedKeys.splice(0)) delete process.env[key];
  while (dirs.length > 0) rmSync(dirs.pop()!, { force: true, recursive: true });
});

function createRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-dotenv-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents, "utf-8");
  }
  return dir;
}

describe("loadDotEnvIntoProcess", () => {
  it("exposes unprefixed keys on process.env", () => {
    touchedKeys.push("PRACHT_TEST_SECRET");
    const root = createRoot({ ".env": "PRACHT_TEST_SECRET=from-file\n" });

    expect(loadDotEnvIntoProcess(root, "development")).toContain("PRACHT_TEST_SECRET");
    expect(process.env.PRACHT_TEST_SECRET).toBe("from-file");
  });

  it("never overrides a real environment variable", () => {
    touchedKeys.push("PRACHT_TEST_SECRET");
    process.env.PRACHT_TEST_SECRET = "from-environment";
    const root = createRoot({ ".env": "PRACHT_TEST_SECRET=from-file\n" });

    expect(loadDotEnvIntoProcess(root, "development")).not.toContain("PRACHT_TEST_SECRET");
    expect(process.env.PRACHT_TEST_SECRET).toBe("from-environment");
  });

  it("never assigns NODE_ENV", () => {
    // Vite refuses `NODE_ENV=production` from a .env file on purpose and only
    // honours `NODE_ENV=development`; assigning it here would run ahead of that
    // guard and silently flip the dev server into production mode.
    touchedKeys.push("PRACHT_TEST_OTHER");
    const root = createRoot({ ".env": "NODE_ENV=production\nPRACHT_TEST_OTHER=1\n" });
    const before = process.env.NODE_ENV;

    const applied = loadDotEnvIntoProcess(root, "development");

    expect(applied).toEqual(["PRACHT_TEST_OTHER"]);
    expect(process.env.NODE_ENV).toBe(before);
  });

  it("honours the requested mode rather than NODE_ENV", () => {
    touchedKeys.push("PRACHT_TEST_TARGET");
    const root = createRoot({
      ".env.development": "PRACHT_TEST_TARGET=dev\n",
      ".env.production": "PRACHT_TEST_TARGET=prod\n",
    });
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      loadDotEnvIntoProcess(root, "development");
      expect(process.env.PRACHT_TEST_TARGET).toBe("dev");
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("lets .env.local win over .env", () => {
    touchedKeys.push("PRACHT_TEST_LAYERED");
    const root = createRoot({
      ".env": "PRACHT_TEST_LAYERED=base\n",
      ".env.local": "PRACHT_TEST_LAYERED=local\n",
    });

    loadDotEnvIntoProcess(root, "development");

    expect(process.env.PRACHT_TEST_LAYERED).toBe("local");
  });

  it("lets mode-specific files override .env.local in Vite order", () => {
    touchedKeys.push("PRACHT_TEST_MODE", "PRACHT_TEST_MODE_LOCAL");
    const root = createRoot({
      ".env": "PRACHT_TEST_MODE=base\nPRACHT_TEST_MODE_LOCAL=base\n",
      ".env.local": "PRACHT_TEST_MODE=local\nPRACHT_TEST_MODE_LOCAL=local\n",
      ".env.development": "PRACHT_TEST_MODE=mode\nPRACHT_TEST_MODE_LOCAL=mode\n",
      ".env.development.local": "PRACHT_TEST_MODE_LOCAL=mode-local\n",
    });

    loadDotEnvIntoProcess(root, "development");

    expect(process.env.PRACHT_TEST_MODE).toBe("mode");
    expect(process.env.PRACHT_TEST_MODE_LOCAL).toBe("mode-local");
  });

  it("returns nothing when there is no .env file", () => {
    expect(loadDotEnvIntoProcess(createRoot({}), "development")).toEqual([]);
  });
});

describe("createDotEnvSync", () => {
  it("follows edits to the files it loaded on reload", () => {
    touchedKeys.push("PRACHT_TEST_EDITED", "PRACHT_TEST_REMOVED", "PRACHT_TEST_ADDED");
    const root = createRoot({
      ".env": "PRACHT_TEST_EDITED=one\nPRACHT_TEST_REMOVED=gone-soon\n",
    });
    const dotEnv = createDotEnvSync(root, "development");

    expect(dotEnv.load().sort()).toEqual(["PRACHT_TEST_EDITED", "PRACHT_TEST_REMOVED"]);
    writeFileSync(join(root, ".env"), "PRACHT_TEST_EDITED=two\nPRACHT_TEST_ADDED=new\n");

    expect(dotEnv.load().sort()).toEqual(["PRACHT_TEST_ADDED", "PRACHT_TEST_EDITED"]);
    expect(process.env.PRACHT_TEST_EDITED).toBe("two");
    expect(process.env.PRACHT_TEST_ADDED).toBe("new");
    expect("PRACHT_TEST_REMOVED" in process.env).toBe(false);
    expect(dotEnv.load()).toEqual([]);
  });

  it("keeps real environment variables and runtime reassignments on reload", () => {
    touchedKeys.push("PRACHT_TEST_SHELL", "PRACHT_TEST_REASSIGNED");
    process.env.PRACHT_TEST_SHELL = "from-environment";
    const root = createRoot({
      ".env": "PRACHT_TEST_SHELL=from-file\nPRACHT_TEST_REASSIGNED=from-file\n",
    });
    const dotEnv = createDotEnvSync(root, "development");
    dotEnv.load();
    process.env.PRACHT_TEST_REASSIGNED = "from-app";

    writeFileSync(join(root, ".env"), "PRACHT_TEST_SHELL=edited\n");
    dotEnv.load();

    expect(process.env.PRACHT_TEST_SHELL).toBe("from-environment");
    expect(process.env.PRACHT_TEST_REASSIGNED).toBe("from-app");
  });
});
