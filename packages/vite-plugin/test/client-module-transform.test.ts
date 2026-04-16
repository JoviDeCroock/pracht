import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { parseAst } from "vite";
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

    // The template literal must still be terminated — i.e. the closing backtick
    // is still present.  Previously the regex matched `export ... function` inside
    // the template and stripped through the first `}` it found, removing the
    // closing backtick and producing an unterminated string.
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

  it("drops dead imports when loop header bindings shadow the server-only name", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

export default function Page() {
  for (const serverOnly of [1]) {
    console.log(serverOnly);
  }
  return <div />;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("for (const serverOnly of [1])");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when classic for-loop headers shadow the server-only name", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

export default function Page() {
  for (let serverOnly = 0; serverOnly < 1; serverOnly++) {
    console.log(serverOnly);
  }
  return <div />;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("for (let serverOnly = 0; serverOnly < 1; serverOnly++)");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when hoisted var bindings shadow the server-only name", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

export default function Page() {
  if (true) {
    var serverOnly = 1;
  }
  return <div>{serverOnly}</div>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("var serverOnly = 1");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when switch cases introduce lexical shadowing", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

export default function Page() {
  switch (1) {
    case 1:
      const serverOnly = 1;
      return <div>{serverOnly}</div>;
    default:
      return <div />;
  }
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("const serverOnly = 1");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when function parameters shadow the server-only name", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

export default function Page() {
  return [1].map((serverOnly) => <div>{serverOnly}</div>);
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain(".map((serverOnly) => <div>{serverOnly}</div>)");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when catch parameters shadow the server-only name", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

export default function Page() {
  try {
    throw new Error("boom");
  } catch (serverOnly) {
    return <div>{String(serverOnly)}</div>;
  }

  return <div />;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("catch (serverOnly)");
    expectValidModuleSource(transformed);
  });

  it("keeps default-exported identifiers while pruning loader-only imports", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

const Page = () => <div>ok</div>;

export default Page;
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("const Page = () => <div>ok</div>;");
    expect(transformed).toContain("export default Page;");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when the remaining matching identifiers are statement labels", () => {
    const source = `
import serverOnly from "../server-only";

export function loader() {
  return serverOnly();
}

export default function Page() {
  serverOnly: for (;;) {
    break serverOnly;
  }

  return <div />;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("serverOnly: for (;;)");
    expect(transformed).toContain("break serverOnly;");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when the remaining matching identifier appears in import.meta", () => {
    const source = `
import meta from "../server-only";

export function loader() {
  return meta();
}

export default function Page() {
  return <div>{import.meta.env.MODE}</div>;
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("import.meta.env.MODE");
    expectValidModuleSource(transformed);
  });

  it("drops dead imports when the remaining matching identifier appears in new.target", () => {
    const source = `
import target from "../server-only";

export function loader() {
  return target();
}

export default function Page() {
  return (() => new.target)();
}
`;

    const transformed = stripServerOnlyExportsForClient(source);

    expect(transformed).not.toContain("../server-only");
    expect(transformed).toContain("new.target");
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

    const output = readBuiltJs(root);

    expect(output).toContain("CLIENT_SHARED");
    expect(output).not.toContain("SERVER_ONLY_MARKER");
  });
});
