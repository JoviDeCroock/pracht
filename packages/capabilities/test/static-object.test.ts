import { describe, expect, it } from "vitest";

import { scanTopLevelProperties, scanTopLevelPropertyEntries } from "../src/static.ts";

describe("static object scanning", () => {
  it("keeps nested schema fields out of the containing contract", () => {
    const properties = scanTopLevelProperties(`
      input: { type: "object", description: "nested" },
      description: "outer",
    `);

    expect(properties.get("description")).toBe('"outer"');
    expect(properties.get("input")).toContain('description: "nested"');
  });

  it("decodes quoted and escaped property keys", () => {
    const properties = scanTopLevelProperties(String.raw`
      "agent\u0050olicy": "require",
      'middleware': ["auth"],
    `);

    expect(properties.get("agentPolicy")).toBe('"require"');
    expect(properties.get("middleware")).toBe('["auth"]');
  });

  it("marks spreads and computed keys as truncated instead of absent", () => {
    const spread = scanTopLevelPropertyEntries(`
      effect: "read",
      ...shared,
      expose: { http: true },
    `);
    expect([...spread.properties.keys()]).toEqual(["effect"]);
    expect(spread.truncated).toBe(true);

    const computed = scanTopLevelPropertyEntries(`
      effect: "read",
      [exposureKey]: { http: true },
    `);
    expect([...computed.properties.keys()]).toEqual(["effect"]);
    expect(computed.truncated).toBe(true);
  });

  it("skips shorthand properties without hiding later explicit policy", () => {
    const scan = scanTopLevelPropertyEntries(`
      routes,
      agents: null,
    `);

    expect(scan.properties.get("agents")).toBe("null");
    expect(scan.truncated).toBe(false);
  });
});
