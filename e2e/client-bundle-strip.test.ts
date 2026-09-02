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

import { fixtureCopyFilter } from "./fixture-copy.ts";

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
// Defined in examples/basic/src/server/notes-store.ts (used only by capabilities).
const CAPABILITY_SERVER_MARKER = "PRACHT_NOTES_STORE_SERVER_MARKER_4c8a";

test("server-only route exports and their imports are stripped from client bundles", async () => {
  test.setTimeout(120_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-client-strip-"));
  const exampleDir = resolve(tempDir, "project");

  try {
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });

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

    // Capability modules are server-only. examples/basic registers
    // notes.search/notes.create via the manifest; their store marker must
    // stay out of every client asset while remaining in the server bundle.
    expect(clientJs).not.toContain(CAPABILITY_SERVER_MARKER);
    expect(serverJs).toContain(CAPABILITY_SERVER_MARKER);

    // The generated browser client (`callCapability` and the nested
    // `capabilities` object) carries only names, endpoints, and effects.
    // Contract prose and input schemas are server-side detail, and reach the
    // browser for WebMCP-exposed capabilities only — an in-page agent needs
    // the tool schema. notes.purge is remote-MCP-exposed but never
    // webmcp-exposed — remote MCP is projected server-side — so neither its
    // description nor its schema may appear in any client asset.
    expect(clientJs).not.toContain("Permanently delete every note whose title");
    expect(clientJs).not.toContain("titlePrefix");
    expect(serverJs).toContain("titlePrefix");

    // notes.search *is* webmcp-exposed, so its schema is expected in the
    // client — proof the assertions above test exposure, not merely that
    // capability text never ships.
    expect(clientJs).toContain("Find notes whose title or body matches the query.");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

// `src/pages/_app.config.ts` carries the app's `agents` block — Web Bot Auth
// public keys, MCP server info, confirmation tuning. The generated manifest
// imports it, and the browser entry imports the manifest, so without a
// server-only projection every one of those values would ship to visitors.
const PAGES_AGENTS_MARKER = "PAGES_AGENTS_CONFIG_MARKER_9d41";
const PAGES_CAPABILITY_MARKER = "PAGES_CAPABILITY_SERVER_MARKER_5e07";

test("pages-router app config and capability modules stay out of client bundles", async () => {
  test.setTimeout(120_000);

  const tempRoot = resolve(repoRoot, ".tmp");
  mkdirSync(tempRoot, { recursive: true });
  const tempDir = mkdtempSync(resolve(tempRoot, "pracht-pages-strip-"));
  const exampleDir = resolve(tempDir, "project");
  const pagesFixture = resolve(repoRoot, "examples/pages-router");

  try {
    cpSync(pagesFixture, exampleDir, { filter: fixtureCopyFilter(pagesFixture), recursive: true });

    writeFileSync(
      resolve(exampleDir, "src/pages/_app.config.ts"),
      `import type { PrachtAgentsConfig } from "@pracht/core";

export const agents: PrachtAgentsConfig = {
  webBotAuth: { policy: "observe", keys: [{ x: ${JSON.stringify(PAGES_AGENTS_MARKER)}, agent: "test.example" }] },
  mcp: { serverInfo: { name: "pracht-pages-example", version: "0.0.0" } },
};
`,
      "utf-8",
    );
    writeFileSync(
      resolve(exampleDir, "src/capabilities/posts-search.ts"),
      `import { defineCapability } from "@pracht/capabilities";

const SECRET = ${JSON.stringify(PAGES_CAPABILITY_MARKER)};

export default defineCapability({
  name: "posts.search",
  title: "Search posts",
  description: "Find blog posts whose title or slug matches the query.",
  effect: "read",
  expose: { http: true, mcp: true },
  input: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { secret: { type: "string" } },
    required: ["secret"],
    additionalProperties: false,
  },
  run() {
    return { secret: SECRET };
  },
});
`,
      "utf-8",
    );

    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    const clientJs = collectJsSource(resolve(exampleDir, "dist/client/assets"));
    const serverJs = collectJsSource(resolve(exampleDir, "dist/server"));

    // The whole point: the config module is server-only, so neither it nor the
    // values it declares may reach a visitor.
    expect(clientJs).not.toContain(PAGES_AGENTS_MARKER);
    expect(clientJs).not.toContain("test.example");
    expect(clientJs).not.toContain(PAGES_CAPABILITY_MARKER);
    // The config module's *path* still appears in the route hint maps, which
    // scan the whole pages directory — a string, not an import edge. What must
    // not appear is the module itself, which the markers above prove.

    // Sanity: the server build really does carry them, so this is not just a
    // broken build passing by omission.
    expect(serverJs).toContain(PAGES_AGENTS_MARKER);
    expect(serverJs).toContain(PAGES_CAPABILITY_MARKER);

    // The client still gets a working route table — proof the projection drops
    // only the server-only keys.
    expect(clientJs).toContain("/blog/:slug");
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
