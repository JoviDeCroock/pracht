import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalModuleId, getAnalysisSession, isWithinRoot } from "../src/analysis.ts";
import {
  createPrachtServerModuleSource,
  createRouteHintsForVirtualModules,
} from "../src/plugin-codegen.ts";
import { resolveOptions } from "../src/plugin-options.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-analysis-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const LOADER_ROUTE =
  "export async function loader() { return {}; }\nexport function Component() { return null; }\n";

describe("canonicalModuleId", () => {
  const root = "/app";

  it("gives every spelling of one module the same id", () => {
    const importer = "/app/src";
    for (const ref of [
      "./routes/home.tsx",
      "routes/home.tsx",
      "/src/routes/home.tsx",
      "/src/other/../routes/home.tsx",
      "../src/routes/./home.tsx",
      "./routes/home.tsx?pracht-client",
    ]) {
      expect(canonicalModuleId(root, ref, importer), ref).toBe("/src/routes/home.tsx");
    }
  });

  it("keeps a module outside the root recognizably outside", () => {
    const id = canonicalModuleId(root, "../../shared/a.tsx", "/app/src");
    expect(id).toBe("/../shared/a.tsx");
    expect(isWithinRoot(id)).toBe(false);
    expect(isWithinRoot(canonicalModuleId(root, "./a.tsx", "/app/src"))).toBe(true);
  });
});

describe("AnalysisSession.module", () => {
  it("answers by id, and sees an edit", () => {
    const root = project({ "src/routes/home.tsx": LOADER_ROUTE });
    const session = getAnalysisSession(resolveOptions({}), root);
    const id = canonicalModuleId(root, "./routes/home.tsx", join(root, "src"));
    expect(session.module(id)?.exports.has("loader")).toBe(true);

    writeFileSync(join(root, "src/routes/home.tsx"), "export const head = () => ({});\n");
    session.invalidate(join(root, "src/routes/home.tsx"));
    expect([...session.module(id)!.exports]).toEqual(["head"]);
    expect(session.module(canonicalModuleId(root, "./missing.tsx", root))).toBeNull();
  });

  // R505-1: the pages scanner and the hint tables read one set of facts, so a
  // fenced example in a Markdown route is not an export to either of them.
  it("reads Markdown with its fenced code masked", () => {
    const root = project({
      "src/routes/docs.md": "# Docs\n\n```ts\nexport async function loader() {}\n```\n",
    });
    const session = getAnalysisSession(resolveOptions({}), root);
    expect(session.module(canonicalModuleId(root, "/src/routes/docs.md", root))?.exports).toEqual(
      new Set(),
    );
  });
});

describe("hint table keys", () => {
  // R506-1: a configured directory alias must not survive into a key that a
  // lookup canonicalizes, on the server tables as well as the browser's.
  it("keys the server tables by module id under an aliased routes directory", () => {
    const root = project({
      "src/routes.ts": "export const app = { routes: [] };\n",
      "src/routes/data.tsx": LOADER_ROUTE,
    });
    const options = { appFile: "/src/routes.ts", routesDir: "/src/other/../routes" };
    const hints = createRouteHintsForVirtualModules(resolveOptions(options), root);
    expect(hints.loader["/src/routes/data.tsx"]).toBe(true);
    expect(hints.loader["./routes/data.tsx"]).toBe(true);
    expect(Object.keys(hints.loader).some((key) => key.includes(".."))).toBe(false);

    const server = createPrachtServerModuleSource(options, { root });
    const table = server.split("\n").find((line) => line.startsWith("const routeLoaderHints"));
    expect(table).toContain('"/src/routes/data.tsx":true');
    expect(table).not.toContain("..");
  });
});

describe("AnalysisSession.manifest", () => {
  function manifestFacts(files: Record<string, string>) {
    const root = project(files);
    return getAnalysisSession(resolveOptions({}), root).manifest();
  }
  const refsTo = (facts: ReturnType<typeof manifestFacts>, id: string) =>
    facts.refs.filter((ref) => ref.id === id).map(({ kind, hydration }) => ({ kind, hydration }));

  // R499-1: the config overload carries its own hydration; a third argument is ignored.
  it("reads a config-object route's hydration over its group's", () => {
    const facts = manifestFacts({
      "src/routes.ts": `import { defineApp, group, route } from "@pracht/core";
export const app = defineApp({ routes: [group({ hydration: "islands" }, [
  route("/full", { component: "./routes/full.tsx", hydration: "full" }),
  route("/maybe", { component: "./routes/maybe.tsx", hydration: FLAG ? "full" : "none" }),
  route("/meta", { component: "./routes/meta.tsx" }, { hydration: "full" }),
])] });
`,
    });
    expect(refsTo(facts, "/src/routes/full.tsx")).toEqual([{ kind: "route", hydration: "full" }]);
    expect(refsTo(facts, "/src/routes/maybe.tsx")).toEqual([
      { kind: "route", hydration: "unknown" },
    ]);
    expect(refsTo(facts, "/src/routes/meta.tsx")).toEqual([
      { kind: "route", hydration: "islands" },
    ]);
  });

  // R499-2: a template literal is the same ref as the string it spells.
  it("reads an expression-free template literal as a ref", () => {
    const facts = manifestFacts({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({ routes: [
  route("/a", "./routes/shared.tsx"),
  route("/b", \`./routes/shared.tsx\`, { hydration: "none" }),
] });
`,
    });
    expect(refsTo(facts, "/src/routes/shared.tsx")).toEqual([
      { kind: "route", hydration: "full" },
      { kind: "route", hydration: "none" },
    ]);
  });

  // R490-2: a computed ref in an imported module makes the read incomplete.
  it("records a computed ref in an imported module as unknown", () => {
    const facts = manifestFacts({
      "src/routes.ts": `import { defineApp } from "@pracht/core";
import { pages } from "./manifest/pages.ts";
export const app = defineApp({ routes: pages });
`,
      "src/manifest/pages.ts": `import { route } from "@pracht/core";
export const pages = ["a"].map((name) => route("/" + name, "./routes/" + name + ".tsx"));
`,
    });
    expect(facts.complete).toBe(false);
    expect(facts.refs.some((ref) => ref.kind === "route" && ref.id === null)).toBe(true);
  });

  // R490-1/3/5: every spelling of an external module is one id, whichever
  // registry, hint table or transform asks, and glob syntax in a name stays literal.
  it("gives every spelling of an external ref one id", () => {
    const facts = manifestFacts({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
import { more } from "./manifest/more.ts";
export const app = defineApp({
  shells: { side: "/src/layouts/side.tsx" },
  routes: [
    route("/a", "./features/a.tsx?raw", { shell: "side" }),
    route("/:id", "features/[id].tsx"),
    ...more,
  ],
});
`,
      "src/manifest/more.ts": `import { route } from "@pracht/core";
export const more = [route("/b", "./features/../features/a.tsx")];
`,
    });
    expect(facts.complete).toBe(true);
    expect(refsTo(facts, "/src/features/a.tsx")).toHaveLength(2);
    expect(refsTo(facts, "/src/features/[id].tsx")).toEqual([{ kind: "route", hydration: "full" }]);
    expect(refsTo(facts, "/src/layouts/side.tsx").map(({ kind }) => kind)).toEqual(["shell"]);
  });
});
