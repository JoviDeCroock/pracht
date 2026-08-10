import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDotEnvIntoProcess } from "../src/dotenv.ts";

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

  it("returns nothing when there is no .env file", () => {
    expect(loadDotEnvIntoProcess(createRoot({}), "development")).toEqual([]);
  });
});
