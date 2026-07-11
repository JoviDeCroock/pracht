import { describe, expect, it } from "vitest";

import { extractCapabilityRegistrations, extractDefineCapabilityArgs } from "../src/static.ts";

describe("capability static extraction", () => {
  it("ignores defineCapability examples in comments and strings", () => {
    const source = `
      // defineCapability({ title: "commented out" })
      const example = "defineCapability({ title: 'inside a string' })";
      export default defineCapability({
        title: "Live capability",
        run() {},
      });
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('title: "Live capability"');
  });

  it("ignores commented-out manifest registrations", () => {
    const source = `
      export const app = defineApp({
        capabilities: {
          // "notes.old": () => import("./capabilities/notes-old.ts"),
          /* "notes.draft": () => import("./capabilities/notes-draft.ts"), */
          "notes.search": () => import("./capabilities/notes-search.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes.search", file: "./capabilities/notes-search.ts" },
    ]);
  });

  it("extracts registrations from a quoted capabilities property", () => {
    const source = `
      export const app = defineApp({
        "capabilities": {
          "notes.search": "./capabilities/notes-search.ts",
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes.search", file: "./capabilities/notes-search.ts" },
    ]);
  });
});
