import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
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
});

describe("client route module build", () => {
  it("excludes imports used only by inline loaders from browser bundles", async () => {
    const root = makeTempProject();
    mkdirSync(join(root, "src", "pages"), { recursive: true });

    writeFileSync(
      join(root, "src", "pages", "index.tsx"),
      `
import serverOnly from "../server-only";
import { shared } from "../shared";

export async function loader() {
  return serverOnly();
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
