import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectManifestModuleRefs,
  createPrachtClientModuleSource,
} from "../src/plugin-codegen.ts";
import { resolveOptions } from "../src/plugin-options.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** An app on disk: `files` are written verbatim, keyed by project-relative path. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-client-registry-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const COMPONENT = "export function Component() {\n  return null;\n}\n";
const SHELL = "export function Shell({ children }) {\n  return children;\n}\n";

/**
 * Every pattern the generated client registry passes to `import.meta.glob`,
 * from all of its calls at once. A single pattern is written as a bare string
 * and a list as an array, so both forms are read here.
 */
function routeGlobPatterns(root: string): string[] {
  const source = createPrachtClientModuleSource({}, { root });
  const patterns: string[] = [];
  for (const match of source.matchAll(/import\.meta\.glob\((\[[^\]]*\]|"(?:[^"\\]|\\.)*")/g)) {
    const argument = JSON.parse(match[1]!) as string | string[];
    patterns.push(...(Array.isArray(argument) ? argument : [argument]));
  }
  return patterns;
}

describe("the client route registry follows the manifest", () => {
  it("excludes a file the manifest never names", () => {
    // Its code and its CSS were published to the client output for a page no
    // URL reaches — a draft, or a route deleted from the manifest but left on
    // disk.
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  shells: { public: "./shells/public.tsx" },
  routes: [route("/", "./routes/home.tsx", { id: "home" })],
});
`,
      "src/routes/draft.tsx": COMPONENT,
      "src/routes/home.tsx": COMPONENT,
      "src/shells/public.tsx": SHELL,
    });

    expect(routeGlobPatterns(root)).toContain("!/src/routes/draft.tsx");
    expect(routeGlobPatterns(root)).not.toContain("!/src/routes/home.tsx");
  });

  it("keeps every form a ref can take", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, group, route } from "@pracht/core";
export const app = defineApp({
  shells: { public: "./shells/public.tsx" },
  routes: [
    route("/", "./routes/home.tsx", { id: "home" }),
    group({ shell: "public" }, [route("/lazy", () => import("./routes/lazy.tsx"), { id: "lazy" })]),
  ],
  notFound: { component: "./routes/not-found.tsx" },
});
`,
      "src/routes/home.tsx": COMPONENT,
      "src/routes/lazy.tsx": COMPONENT,
      "src/routes/not-found.tsx": COMPONENT,
      "src/shells/public.tsx": SHELL,
    });

    const patterns = routeGlobPatterns(root);
    for (const kept of ["home", "lazy", "not-found"]) {
      expect(patterns).not.toContain(`!/src/routes/${kept}.tsx`);
    }
    expect(patterns).not.toContain("!/src/shells/public.tsx");
  });

  it("excludes a shared module that lives under the routes directory", () => {
    // It is still imported by the route that uses it; what it stops being is
    // an independent entry in the registry.
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({ routes: [route("/", "./routes/home.tsx", { id: "home" })] });
`,
      "src/routes/home.tsx": `import { Card } from "./parts/Card.tsx";\n${COMPONENT}`,
      "src/routes/parts/Card.tsx": "export function Card() {\n  return null;\n}\n",
    });

    expect(routeGlobPatterns(root)).toContain("!/src/routes/parts/Card.tsx");
  });

  it("leaves the registry alone when the manifest imports its routes from elsewhere", () => {
    // Dropping a module a route needs breaks navigation to that route, which is
    // worse than shipping one nothing reaches. A ref this file cannot see means
    // no exclusions at all.
    const root = project({
      "src/routes.ts": `import { defineApp } from "@pracht/core";
import { marketing } from "./marketing-routes.ts";
export const app = defineApp({ routes: [...marketing] });
`,
      "src/marketing-routes.ts": `import { route } from "@pracht/core";
export const marketing = [route("/pricing", "./routes/pricing.tsx", { id: "pricing" })];
`,
      "src/routes/pricing.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(false);
    expect(routeGlobPatterns(root).filter((pattern) => pattern.startsWith("!"))).toEqual([]);
  });

  it("leaves the registry alone when a specifier is assembled at runtime", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
const dir = "./routes";
export const app = defineApp({
  routes: [route("/", () => import(dir + "/home.tsx"), { id: "home" })],
});
`,
      "src/routes/draft.tsx": COMPONENT,
      "src/routes/home.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(false);
    expect(routeGlobPatterns(root)).not.toContain("!/src/routes/draft.tsx");
  });

  it("reads a bare package import as no threat to the scan", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
import { z } from "zod";
export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home", meta: { schema: z } })],
});
`,
      "src/routes/draft.tsx": COMPONENT,
      "src/routes/home.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(true);
    expect(routeGlobPatterns(root)).toContain("!/src/routes/draft.tsx");
  });

  it("does not mistake a route path or a middleware ref for a route module", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  middleware: { gate: "./middleware/gate.ts" },
  routes: [route("/", "./routes/home.tsx", { id: "home", middleware: ["gate"] })],
});
`,
      "src/middleware/gate.ts": "export const middleware = (args, next) => next();\n",
      "src/routes/home.tsx": COMPONENT,
    });

    const refs = collectManifestModuleRefs(resolveOptions({}), root);
    expect(refs.complete).toBe(true);
    expect([...refs.files].map((file) => file.slice(root.length))).toEqual([
      "/src/routes/home.tsx",
    ]);
  });

  it("leaves the pages router's directory alone, where a file is a route", () => {
    const root = project({
      "src/pages/index.tsx": COMPONENT,
      "src/pages/about.tsx": COMPONENT,
    });

    const patterns = routeGlobPatterns(root);
    expect(patterns).not.toContain("!/src/pages/about.tsx");
  });
});

describe("client-side search validation", () => {
  const MANIFEST = `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home" })],
});
`;

  it("ships the parser when a route module exports a search schema", () => {
    const root = project({
      "src/routes.ts": MANIFEST,
      "src/routes/home.tsx": `export const search = schema;\n${COMPONENT}`,
    });

    expect(createPrachtClientModuleSource({}, { root })).toContain(
      "    parseSearch: parseRouteSearch,",
    );
  });

  it("keeps the parser out of production builds when no route declares a schema", () => {
    const root = project({ "src/routes.ts": MANIFEST, "src/routes/home.tsx": COMPONENT });

    // Dev keeps it so the first `search` export works without regenerating
    // the entry; the production build folds the branch and drops the import.
    expect(createPrachtClientModuleSource({}, { root })).toContain(
      "    parseSearch: import.meta.env.DEV ? parseRouteSearch : undefined,",
    );
  });
});
