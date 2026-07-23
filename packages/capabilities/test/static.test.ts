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

  it("extracts the default-exported call, not a preceding helper", () => {
    const source = `
      const helper = defineCapability({ title: "Helper", run() {} });
      export default defineCapability({
        title: "Exported",
        run() {},
      });
    `;

    const args = extractDefineCapabilityArgs(source);
    expect(args).toContain('title: "Exported"');
    expect(args).not.toContain('title: "Helper"');
  });

  it("resolves an identifier default export to its declaration", () => {
    const source = `
      const cap = defineCapability({ title: "Via const", run() {} });
      export default cap;
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('title: "Via const"');
  });

  it("does not truncate at a brace inside a regex literal", () => {
    const source = `
      export default defineCapability({
        title: "Regex",
        run({ input }) {
          return { ok: input.text.match(/[{}]/) !== null };
        },
        effect: "read",
      });
    `;

    expect(extractDefineCapabilityArgs(source)).toContain('effect: "read"');
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
      const example = '"capabilities": { "notes.fake": "./fake.ts" }';
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
