import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCapabilityProjectionsAgree,
  type GraphCapabilityExposure,
} from "../src/capability-consistency.ts";
import type { ProjectConfig } from "../src/project.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createApp(capabilitySources: Record<string, string>): ProjectConfig {
  const root = mkdtempSync(join(tmpdir(), "pracht-capability-consistency-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src/capabilities"), { recursive: true });
  writeFileSync(join(root, "src/routes.ts"), "export const app = {};\n", "utf-8");
  for (const [file, source] of Object.entries(capabilitySources)) {
    writeFileSync(join(root, "src/capabilities", file), source, "utf-8");
  }
  // Project paths are root-relative with a leading slash (resolveProjectPath
  // resolves them as "./<path>"), matching PROJECT_DEFAULTS.
  return { appFile: "/src/routes.ts", root } as ProjectConfig;
}

/** `expose: null` omits the property entirely — how a private capability reads. */
function capabilitySource({
  effect = '"read"',
  expose = "{ http: true }",
}: { effect?: string; expose?: string | null } = {}): string {
  return `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Search notes",
  description: "Find notes.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: { type: "object", properties: {}, additionalProperties: false },
  effect: ${effect},
${expose === null ? "" : `  expose: ${expose},\n`}  async run() {
    return {};
  },
});
`;
}

function graphEntry(overrides: Partial<GraphCapabilityExposure> = {}): GraphCapabilityExposure {
  return {
    effect: "read",
    httpPath: "/api/capabilities/notes/search",
    name: "notes.search",
    source: "./capabilities/notes-search.ts",
    transports: ["http"],
    ...overrides,
  };
}

describe("assertCapabilityProjectionsAgree", () => {
  it("passes when the executed graph and static analysis match", () => {
    const project = createApp({ "notes-search.ts": capabilitySource() });

    expect(() => assertCapabilityProjectionsAgree(project, [graphEntry()])).not.toThrow();
  });

  it("passes for private capabilities, whose effect static analysis never reads", () => {
    const project = createApp({
      "notes-search.ts": capabilitySource({ effect: '"write"', expose: null }),
    });

    expect(() =>
      assertCapabilityProjectionsAgree(project, [
        graphEntry({ effect: "write", httpPath: null, transports: [] }),
      ]),
    ).not.toThrow();
  });

  it("leaves module-load failures to the wiring checks", () => {
    const project = createApp({ "notes-search.ts": capabilitySource() });

    // serializeCapabilities() retains a null-metadata graph entry when the
    // module fails to load. Its source can still be perfectly analyzable, so
    // comparing the fallback null endpoint would misdiagnose the load failure
    // as a computed expose/effect value.
    expect(() =>
      assertCapabilityProjectionsAgree(project, [
        graphEntry({ effect: null, httpPath: null, transports: [] }),
      ]),
    ).not.toThrow();
  });

  it("reports an endpoint the browser bundle would never register", () => {
    // The graph says http-exposed (so generated types would allow a browser
    // call); the source says private (so the client has no endpoint for it).
    const project = createApp({
      "notes-search.ts": capabilitySource({ expose: null }),
    });

    expect(() => assertCapabilityProjectionsAgree(project, [graphEntry()])).toThrow(
      /HTTP endpoint is "\/api\/capabilities\/notes\/search" in the app graph but none in static analysis/,
    );
  });

  it("reports a mismatched effect class on an exposed capability", () => {
    const project = createApp({ "notes-search.ts": capabilitySource({ effect: '"write"' }) });

    expect(() =>
      assertCapabilityProjectionsAgree(project, [graphEntry({ effect: "destructive" })]),
    ).toThrow(/effect is "destructive" in the app graph but "write" in static analysis/);
  });

  it("reports mismatched WebMCP exposure", () => {
    const project = createApp({ "notes-search.ts": capabilitySource() });

    expect(() =>
      assertCapabilityProjectionsAgree(project, [graphEntry({ transports: ["http", "webmcp"] })]),
    ).toThrow(/WebMCP exposure is on in the app graph but off in static analysis/);
  });

  it("reports an exposed capability whose projection static analysis cannot read", () => {
    // The most common real divergence: `expose` computed from a hoisted const.
    // The graph read it by executing the module, the client projection cannot
    // read it at all, so the emitted types would describe an endpoint the
    // browser bundle never registers. Staying quiet here would leave this check
    // contributing nothing in the exact case it exists for.
    const project = createApp({
      "notes-search.ts": capabilitySource({ expose: "EXPOSE_CONFIG" }),
    });

    expect(() => assertCapabilityProjectionsAgree(project, [graphEntry()])).toThrow(
      /static analysis cannot read its projection/,
    );
  });

  it("stays quiet when an unreadable capability is private in the graph too", () => {
    // Nothing is projected to the client, so there is no divergence to report;
    // the build raises its own error for a genuinely broken source.
    const project = createApp({ "notes-search.ts": "export default {};\n" });

    expect(() =>
      assertCapabilityProjectionsAgree(project, [graphEntry({ httpPath: null, transports: [] })]),
    ).not.toThrow();
  });

  it("ignores capabilities whose source file is missing", () => {
    const project = createApp({});

    expect(() => assertCapabilityProjectionsAgree(project, [graphEntry()])).not.toThrow();
  });
});
