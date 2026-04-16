import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

// Regression coverage for https://github.com/JoviDeCroock/pracht/pull/116 —
// "Strip server-only route exports from client bundles".  Builds a copy of
// examples/basic with a route whose loader references a distinctive marker
// string (plus an import only the loader uses) and asserts those markers do
// NOT survive into the client JS bundle.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/basic");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

const SERVER_ONLY_MARKER = "SERVER_ONLY_STRIP_MARKER_7f3c";
const LOADER_BODY_MARKER = "LOADER_BODY_STRIP_MARKER_2a91";
const COMPONENT_MARKER = "COMPONENT_STRIP_MARKER_b55e";

test("server-only route exports and their imports are stripped from client bundles", async () => {
  test.setTimeout(120_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-client-strip-"));
  const exampleDir = resolve(tempDir, "project");

  cpSync(fixtureDir, exampleDir, {
    filter(source) {
      return ![".vercel", "dist", "test-results"].some((entry) =>
        source.includes(`/examples/basic/${entry}`),
      );
    },
    recursive: true,
  });

  try {
    writeFileSync(
      resolve(exampleDir, "src/secret.ts"),
      `export const secretMessage = ${JSON.stringify(SERVER_ONLY_MARKER)};\n`,
      "utf-8",
    );

    writeFileSync(
      resolve(exampleDir, "src/routes/strip-marker.tsx"),
      [
        `import type { LoaderArgs, RouteComponentProps } from "@pracht/core";`,
        `import { secretMessage } from "../secret.ts";`,
        ``,
        `export async function loader(_args: LoaderArgs) {`,
        `  const marker = ${JSON.stringify(LOADER_BODY_MARKER)};`,
        `  return { marker, secret: secretMessage };`,
        `}`,
        ``,
        `export function Component({ data }: RouteComponentProps<typeof loader>) {`,
        `  return (`,
        `    <section>`,
        `      <h1>${COMPONENT_MARKER}</h1>`,
        `      <p>{data.marker}</p>`,
        `    </section>`,
        `  );`,
        `}`,
        ``,
      ].join("\n"),
      "utf-8",
    );

    const routesPath = resolve(exampleDir, "src/routes.ts");
    const routesSource = readFileSync(routesPath, "utf-8");
    writeFileSync(
      routesPath,
      routesSource.replace(
        'route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),',
        `route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),\n      route("/strip-marker", () => import("./routes/strip-marker.tsx"), { id: "strip-marker", render: "ssr" }),`,
      ),
      "utf-8",
    );

    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: {
        ...process.env,
        NODE_OPTIONS: "--experimental-strip-types",
        PRACHT_ADAPTER: "node",
      },
      stdio: "pipe",
    });

    const clientJs = collectJsSource(resolve(exampleDir, "dist/client/assets"));
    const serverJs = collectJsSource(resolve(exampleDir, "dist/server"));

    // The component body must survive into the client bundle — otherwise the
    // strip transform has been too aggressive.
    expect(clientJs).toContain(COMPONENT_MARKER);

    // The loader body and anything imported solely by the loader must not.
    expect(clientJs).not.toContain(LOADER_BODY_MARKER);
    expect(clientJs).not.toContain(SERVER_ONLY_MARKER);

    // Sanity: both strings do exist server-side, so the strip isn't just a
    // silent broken build.
    expect(serverJs).toContain(LOADER_BODY_MARKER);
    expect(serverJs).toContain(SERVER_ONLY_MARKER);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function collectJsSource(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  const pieces: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
    const parent =
      (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      dir;
    pieces.push(readFileSync(resolve(parent, entry.name), "utf-8"));
  }
  return pieces.join("\n");
}
