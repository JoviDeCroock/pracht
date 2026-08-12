import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  writeGeneratedLlmsTxt,
  writeOpenApiBuildArtifacts,
  writePrerenderedPages,
} from "../src/build-static-output.ts";

const tempRoots: string[] = [];

function createOutput(): { clientDir: string; logs: string[]; root: string } {
  const root = mkdtempSync(join(tmpdir(), "pracht-static-output-"));
  const clientDir = join(root, "dist/client");
  mkdirSync(clientDir, { recursive: true });
  tempRoots.push(root);

  const logs: string[] = [];
  return { clientDir, logs, root };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
});

describe("writePrerenderedPages", () => {
  it("writes nested route output and reports its project-relative path", () => {
    const { clientDir, logs, root } = createOutput();

    writePrerenderedPages([{ path: "/docs/start", html: "<h1>Start</h1>" }], {
      clientDir,
      root,
      log: (message) => logs.push(message),
    });

    expect(readFileSync(join(clientDir, "docs/start/index.html"), "utf-8")).toBe("<h1>Start</h1>");
    expect(logs).toContain("    /docs/start → dist/client/docs/start/index.html");
  });
});

describe("writeGeneratedLlmsTxt", () => {
  it("warns when generated output replaces a public file", () => {
    const { clientDir, logs, root } = createOutput();
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(join(root, "public/llms.txt"), "hand-authored", "utf-8");

    writeGeneratedLlmsTxt("generated", {
      clientDir,
      root,
      log: (message) => logs.push(message),
    });

    expect(readFileSync(join(clientDir, "llms.txt"), "utf-8")).toBe("generated");
    expect(logs.join("\n")).toContain("public/llms.txt is overwritten");
  });
});

describe("writeOpenApiBuildArtifacts", () => {
  it("writes validated artifacts and returns generated static routes", () => {
    const { clientDir, logs, root } = createOutput();
    writeFileSync(join(clientDir, "openapi.json"), "old", "utf-8");

    const staticRoutes = writeOpenApiBuildArtifacts(
      {
        artifacts: [
          { outputPath: "openapi.json", content: "{}", path: "/openapi.json" },
          { outputPath: "docs/index.html", content: "docs", path: "/docs" },
        ],
        warnings: [{ method: "GET", path: "/users", message: "Missing response schema" }],
      },
      { clientDir, root, log: (message) => logs.push(message) },
    );

    expect(staticRoutes).toEqual(["/docs"]);
    expect(readFileSync(join(clientDir, "openapi.json"), "utf-8")).toBe("{}");
    expect(readFileSync(join(clientDir, "docs/index.html"), "utf-8")).toBe("docs");
    expect(logs.join("\n")).toContain("OpenAPI artifact openapi.json replaces an existing");
    expect(logs.join("\n")).toContain("OpenAPI warning: GET /users: Missing response schema");
  });

  it("rejects duplicate and unsafe artifact paths", () => {
    const { clientDir, root } = createOutput();
    const options = { clientDir, root, log: () => undefined };

    expect(() =>
      writeOpenApiBuildArtifacts(
        {
          artifacts: [
            { outputPath: "openapi.json", content: "{}" },
            { outputPath: "openapi.json", content: "{}" },
          ],
        },
        options,
      ),
    ).toThrow(/duplicate output path/);
    expect(() =>
      writeOpenApiBuildArtifacts(
        { artifacts: [{ outputPath: "../server/openapi.json", content: "{}" }] },
        options,
      ),
    ).toThrow(/outside dist\/client/);
  });
});
