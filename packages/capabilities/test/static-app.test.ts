import { describe, expect, it } from "vitest";

import { extractCapabilityRegistrations } from "../src/static.ts";

describe("app manifest static extraction", () => {
  it("ignores commented-out capability registrations", () => {
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

  it("decodes escaped quoted manifest property names", () => {
    const source = String.raw`
      export const app = defineApp({
        "capabil\u0069ties": {
          "notes.search": "./capabilities/notes-search.ts",
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "notes.search", file: "./capabilities/notes-search.ts" },
    ]);
  });

  it("scopes registrations to the exported defineApp object", () => {
    const source = `
      const metadata = {
        capabilities: {
          "wrong.tool": () => import("./wrong.ts"),
        },
      };
      export const app = defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });

  it("ignores exported-app lookalikes inside regex literals", () => {
    const source = `
      const pattern = /export default defineApp()/;
      export default defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });

  it("extracts registrations from a typed exported app binding", () => {
    const source = `
      export const app: PrachtApp = defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });

  it("extracts registrations from a local binding re-exported as app", () => {
    const source = `
      const manifest = defineApp({
        capabilities: {
          "right.tool": () => import("./right.ts"),
        },
        routes: [],
      });
      export { manifest as app };
    `;

    expect(extractCapabilityRegistrations(source)).toEqual([
      { name: "right.tool", file: "./right.ts" },
    ]);
  });
});
