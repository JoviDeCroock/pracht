import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, parseAst } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { pracht } from "../src/index.ts";
import { stripServerOnlyExportsForClient } from "../src/client-module-transform.ts";

const tempDirs: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-client-route-"));
  tempDirs.push(dir);
  return dir;
}

function readBuiltJs(root: string): string {
  const assetsDir = join(root, "dist", "assets");
  return readdirSync(assetsDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(assetsDir, file), "utf-8"))
    .join("\n");
}

function expectValidModuleSource(code: string): void {
  expect(() => parseAst(code, { lang: "tsx" })).not.toThrow();
}

async function buildTempProject(root: string): Promise<void> {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: await pracht({ pagesDir: "/src/pages" }),
    resolve: {
      alias: [
        {
          find: "@pracht/core",
          replacement: resolve(repoRoot, "packages/framework/src/index.ts"),
        },
        {
          find: "preact/jsx-dev-runtime",
          replacement: resolve(
            repoRoot,
            "node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js",
          ),
        },
        {
          find: "preact/jsx-runtime",
          replacement: resolve(
            repoRoot,
            "node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js",
          ),
        },
        {
          find: "preact/hooks",
          replacement: resolve(repoRoot, "node_modules/preact/hooks/dist/hooks.module.js"),
        },
        {
          find: "preact/devtools",
          replacement: resolve(repoRoot, "node_modules/preact/devtools/dist/devtools.module.js"),
        },
        {
          find: "preact/debug",
          replacement: resolve(repoRoot, "node_modules/preact/debug/dist/debug.module.js"),
        },
        { find: "preact", replacement: resolve(repoRoot, "node_modules/preact/dist/preact.mjs") },
      ],
    },
    build: {
      outDir: "dist",
      manifest: true,
      rollupOptions: {
        input: "virtual:pracht/client",
      },
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("stripServerOnlyExportsForClient", () => {
  it("removes server-only exports and imports used only by those exports", () => {
    const source = `
import serverOnly from "../server-only";
import { shared } from "../shared";
import type { LoaderArgs } from "@pracht/core";

export async function loader({ request }: LoaderArgs) {
  request.headers.get("cookie");
  return serverOnly();
}

export function head() {
  return { title: serverOnly() };
}

export default function Home() {
  return <main>{shared}</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).not.toContain("function loader");
    expect(transformed).not.toContain("function head");
    expect(transformed).not.toContain(": LoaderArgs");
    expect(transformed).toContain("../shared");
    expect(transformed).toContain("function Home");
  });

  it("does not strip export declarations that appear inside string/template literals", () => {
    const source = [
      "import { CodeBlock } from '../components';",
      "",
      "export default function Home() {",
      "  return (",
      "    <CodeBlock",
      "      code={`",
      "export async function loader() {",
      "  return {};",
      "}",
      "",
      "export function head() {",
      "  return { title: 'x' };",
      "}",
      "`}",
      "    />",
      "  );",
      "}",
      "",
    ].join("\n");

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain("`}");
    expect(transformed).toContain("export async function loader");
    expect(transformed).toContain("export function head");
    expect(transformed).toContain("function Home");
  });

  it("does not strip export specifiers that appear inside string/template literals", () => {
    const source = [
      "const docs = `export { loader } from './foo';`;",
      "",
      "export default function Home() {",
      "  return docs;",
      "}",
      "",
    ].join("\n");

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain("export { loader } from './foo';");
  });

  it("handles typed server-only function signatures without corrupting the module", () => {
    const source = `
import serverOnly from "../server-only";

export function loader(): { ok: boolean } {
  return { ok: !!serverOnly };
}

export default function Page() {
  return <main>ok</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).not.toContain("function loader");
    expect(transformed).toContain("function Page");
    expectValidModuleSource(transformed);
  });

  it("keeps imports referenced through TypeScript `as` assertions in client code", () => {
    const source = `
import shared from "../shared";

export function loader() {
  return shared();
}

export default function Page() {
  return <main>{shared as string}</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain("../shared");
    expect(transformed).toContain("shared as string");
    expectValidModuleSource(transformed);
  });

  it("keeps imports referenced through TypeScript non-null assertions in client code", () => {
    const source = `
import shared from "../shared";

export function loader() {
  return shared();
}

export default function Page() {
  return <main>{shared!}</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain("../shared");
    expect(transformed).toContain("shared!");
    expectValidModuleSource(transformed);
  });

  it("keeps imports referenced through TypeScript `satisfies` expressions in client code", () => {
    const source = `
import shared from "../shared";

export function loader() {
  return shared();
}

export default function Page() {
  return <main>{shared satisfies unknown}</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain("../shared");
    expect(transformed).toContain("shared satisfies unknown");
    expectValidModuleSource(transformed);
  });

  it("keeps client exports when server-only declarators share the same export statement", () => {
    const source = `
import serverOnly from "../server-only";

export const loader = () => serverOnly(), shared = 1;

export default function Page() {
  return <main>{shared}</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toMatch(/export\s+const\s+shared\s*=\s*1/);
    expect(transformed).toContain("shared");
    expectValidModuleSource(transformed);
  });

  it("preserves import attributes when pruning unused import specifiers", () => {
    const source = `
import { loaderDep, shared } from "./data.json" with { type: "json" };

export function loader() {
  return loaderDep;
}

export default function Page() {
  return <div>{shared}</div>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain('import { shared } from "./data.json" with { type: "json" };');
    expect(transformed).not.toContain("loaderDep");
    expectValidModuleSource(transformed);
  });

  it("preserves re-export attributes when pruning server-only specifiers", () => {
    const source = `
export { loader, shared } from "./data.json" with { type: "json" };

export default function Page() {
  return <div>ok</div>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain('export { shared } from "./data.json" with { type: "json" };');
    expect(transformed).not.toContain("export { loader");
    expectValidModuleSource(transformed);
  });

  it("preserves mixed default and named import clauses when pruning loader-only specifiers", () => {
    const source = `
import data, { loaderDep, shared as label } from "./data.json" with { type: "json" };

export function loader() {
  return loaderDep;
}

export default function Page() {
  return <div>{data.title}{label}</div>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).toContain(
      'import data, { shared as label } from "./data.json" with { type: "json" };',
    );
    expect(transformed).not.toContain("loaderDep");
    expectValidModuleSource(transformed);
  });

  it("removes local server-only re-exports and their dead imports", () => {
    const source = `
import serverOnly from "../server-only";

const loader = () => serverOnly();

export { loader };

export default function Page() {
  return <main>ok</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).not.toContain("export { loader");
    expect(transformed).not.toContain("const loader");
    expectValidModuleSource(transformed);
  });

  it("removes aliased local server-only re-exports while preserving client aliases", () => {
    const source = `
import serverOnly from "../server-only";

const loadRoute = () => serverOnly();
const shared = 1;

export { loadRoute as loader, shared as pageData };

export default function Page() {
  return <main>{shared}</main>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).not.toContain("loadRoute as loader");
    expect(transformed).toContain("export { shared as pageData };");
    expect(transformed).not.toContain("const loadRoute");
    expectValidModuleSource(transformed);
  });

  it("parses transformed markdown route modules through the post-transform client path", () => {
    const source = `
import { h } from "preact";

export function head() {
  return { title: "docs" };
}

export function Component() {
  return h("div", null, "docs");
}
`;

    const transformed = stripServerOnlyExportsForClient(
      source,
      "/src/routes/docs/page.md?pracht-client",
    );

    expect(transformed).not.toContain("function head");
    expect(transformed).toContain("function Component");
    expectValidModuleSource(transformed);
  });
});

describe("client route module build", () => {
  it("excludes imports used only by typed inline loaders from browser bundles", async () => {
    const root = makeTempProject();
    mkdirSync(join(root, "src", "pages"), { recursive: true });

    writeFileSync(
      join(root, "src", "pages", "index.tsx"),
      `
import serverOnly from "../server-only";
import { shared } from "../shared";

export function loader(): { ok: string } {
  return { ok: serverOnly() };
}

export default function Home() {
  return <main>{shared}</main>;
}
`,
    );
    writeFileSync(
      join(root, "src", "server-only.ts"),
      'export default function serverOnly() { return "SERVER_ONLY_MARKER"; }\n',
    );
    writeFileSync(join(root, "src", "shared.ts"), 'export const shared = "CLIENT_SHARED";\n');

    await buildTempProject(root);

    const output = readBuiltJs(root);

    expect(output).toContain("CLIENT_SHARED");
    expect(output).not.toContain("SERVER_ONLY_MARKER");
  });

  it("excludes dead server-only imports when import.meta is the remaining client syntax", async () => {
    const root = makeTempProject();
    mkdirSync(join(root, "src", "pages"), { recursive: true });

    writeFileSync(
      join(root, "src", "pages", "index.tsx"),
      `
import meta from "../server-only";

export function loader() {
  return meta();
}

export default function Home() {
  return <main>{import.meta.env.MODE}</main>;
}
`,
    );
    writeFileSync(
      join(root, "src", "server-only.ts"),
      'export default function serverOnly() { return "SERVER_ONLY_META_MARKER"; }\n',
    );

    await buildTempProject(root);

    const output = readBuiltJs(root);

    expect(output).not.toContain("SERVER_ONLY_META_MARKER");
  });

  it("strips server-only exports from route files in the client environment even without the pracht-client query", async () => {
    // Regression: before the fix, stripping ran only when the module id
    // carried the `?pracht-client` query added by the import.meta.glob
    // registry. A client component that imported a route module directly
    // (no query) slipped past the transform and exposed the loader.
    const plugins = await pracht({ pagesDir: "/src/pages" });
    const transformPlugin = plugins.find((p) => p.name === "pracht:client-module-transform");
    if (!transformPlugin || typeof transformPlugin.transform !== "function") {
      throw new Error("pracht:client-module-transform plugin is missing a transform hook");
    }
    // Bring the plugin out of its "not yet configured" state so it knows
    // where the pages dir is on disk.
    const configResolved = findPrachtConfigResolved(plugins);
    configResolved({ root: "/project", command: "build" } as never);

    const routeFileId = "/project/src/pages/index.tsx";
    const source = [
      "export function loader() {",
      '  return "SERVER_ONLY_LOADER_MARKER";',
      "}",
      "export function head() {",
      '  return { title: "x" };',
      "}",
      "export default function Home() {",
      '  return "ok";',
      "}",
      "",
    ].join("\n");

    // Client transform — no ?pracht-client query. Must strip.
    const clientResult = await callTransform(transformPlugin.transform, source, routeFileId, {
      ssr: false,
    });
    expect(clientResult).not.toBeNull();
    expect(clientResult).not.toContain("SERVER_ONLY_LOADER_MARKER");
    expect(clientResult).not.toContain("function loader");
    expect(clientResult).not.toContain("function head");
    expect(clientResult).toContain("function Home");

    // SSR transform — must NOT strip (server needs the loader).
    const ssrResult = await callTransform(transformPlugin.transform, source, routeFileId, {
      ssr: true,
    });
    expect(ssrResult).toBeNull();

    // Non-route file in the client environment — must NOT be touched.
    const componentResult = await callTransform(
      transformPlugin.transform,
      source,
      "/project/src/components/sidebar.tsx",
      { ssr: false },
    );
    expect(componentResult).toBeNull();
  });
});

type TransformHook = Parameters<typeof Object.getPrototypeOf>[0];

function findPrachtConfigResolved(plugins: readonly unknown[]): (config: unknown) => void {
  for (const plugin of plugins) {
    if (
      plugin &&
      typeof plugin === "object" &&
      (plugin as { name?: string }).name === "pracht" &&
      typeof (plugin as { configResolved?: unknown }).configResolved === "function"
    ) {
      return (plugin as { configResolved: (config: unknown) => void }).configResolved;
    }
  }
  throw new Error("pracht plugin not found");
}

async function callTransform(
  transform: unknown,
  code: string,
  id: string,
  options: { ssr: boolean },
): Promise<string | null> {
  const handler =
    typeof transform === "function" ? transform : (transform as { handler: TransformHook }).handler;
  const result = await (handler as (c: string, i: string, o: { ssr: boolean }) => unknown).call(
    {} as never,
    code,
    id,
    options,
  );
  if (result === null || result === undefined) return null;
  if (typeof result === "string") return result;
  return (result as { code: string }).code;
}
