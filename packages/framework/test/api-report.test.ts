import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  API_REPORT_PATH,
  describeApiReportDrift,
  diffApiReports,
  generateApiReport,
} from "../scripts/api-report.ts";

describe("@pracht/core API report", () => {
  it("matches the checked-in packages/framework/api-report.api.md", { timeout: 120_000 }, () => {
    const expected = readFileSync(API_REPORT_PATH, "utf-8");
    const actual = generateApiReport();
    if (actual !== expected) {
      throw new Error(describeApiReportDrift(expected, actual));
    }
  });

  it("names added and removed exports by entry point", () => {
    const before = [
      "## `@pracht/core`",
      "",
      "```text",
      "defineApp: function",
      "route: function",
      "```",
    ].join("\n");
    const after = before.replace("route: function", "RouteConfig: interface");
    expect(diffApiReports(before, after)).toEqual({
      added: ["`@pracht/core`  RouteConfig: interface"],
      removed: ["`@pracht/core`  route: function"],
    });
    const message = describeApiReportDrift(before, after);
    expect(message).toContain("+ `@pracht/core`  RouteConfig: interface");
    expect(message).toContain("- `@pracht/core`  route: function");
    expect(message).toContain("pnpm api:update");
  });
});
