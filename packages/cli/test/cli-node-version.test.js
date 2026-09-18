import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { meetsMinimum, unsupportedNodeMessage } from "../bin/node-version.js";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const binEntry = resolve(packageRoot, "bin/pracht.js");

describe("meetsMinimum", () => {
  it("compares numerically rather than lexically", () => {
    // "9" > "22" as strings; the Node the CLI runs on is the one that matters.
    expect(meetsMinimum("9.0.0", "22.18.0")).toBe(false);
    expect(meetsMinimum("22.18.0", "22.18")).toBe(true);
    expect(meetsMinimum("22.17.9", "22.18")).toBe(false);
    expect(meetsMinimum("24.0.0", "22.18")).toBe(true);
  });

  it("treats a missing part as zero", () => {
    expect(meetsMinimum("22", "22.18")).toBe(false);
    expect(meetsMinimum("23", "22.18")).toBe(true);
  });
});

describe("unsupportedNodeMessage", () => {
  it("names the required and the found version, not an export", () => {
    const message = unsupportedNodeMessage("18.17.1", ">=22.18");

    expect(message).toContain("pracht requires Node >= 22.18 (found 18.17.1).");
    expect(message).toContain(".nvmrc");
    expect(message).not.toContain("styleText");
  });

  it("says nothing on a supported Node", () => {
    expect(unsupportedNodeMessage("22.18.0", ">=22.18")).toBeNull();
  });

  it("reads the minimum from this package's own engines field", () => {
    const engines = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf-8")).engines
      .node;

    // The bin checks against `engines.node`, so a bump there must not need a
    // second edit in the check.
    expect(unsupportedNodeMessage("18.17.1", engines)).toContain(
      `pracht requires Node >= ${engines.replace(/^\D*/, "")}`,
    );
    expect(unsupportedNodeMessage(process.versions.node, engines)).toBeNull();
  });
});

describe("the bin entry", () => {
  it("still runs the CLI on a supported Node", () => {
    const output = execFileSync(process.execPath, [binEntry, "--version"], { encoding: "utf-8" });

    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
