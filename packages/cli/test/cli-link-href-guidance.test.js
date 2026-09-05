import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  coreDistTypesPath,
  createRepoTempDir,
  runCli,
  standardSchemaImportPath,
  tscPath,
  typecheckFixture,
  virtualTypesPath,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

// These tests spawn `tsc` — ~1s each, which is unusual for this suite and worth
// the cost here. What is under test is a *diagnostic message*: a type-level
// assertion (`@ts-expect-error`, `expectTypeOf`) can only prove that some error
// occurred, and a runtime assertion on the string literal proves nothing at all,
// because `import type` is erased before the test runs. Only the compiler's
// actual output can show that the sentence reaches the reader unelided.
//
// The sentence `LinkProps["href"]` carries. Kept here as a plain string rather
// than imported as a type, so this test fails if the declaration is removed
// instead of quietly agreeing with itself.
const GUIDANCE =
  "`href` is not a <Link> prop: <Link> builds its own href from `route` and `params`. " +
  "Use a generated route id with <Link route={routeId}>, a plain <a href> for external " +
  "and user-provided URLs, or omit href from the props you spread here.";

// TypeScript escapes double quotes when it prints a string literal type. Keep
// the expected diagnostic form separate so future wording can include them.
const PRINTED_GUIDANCE = GUIDANCE.replace(/"/g, '\\"');

function writeTsconfig(appDir) {
  writeProjectFile(
    appDir,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          jsx: "react-jsx",
          jsxImportSource: "preact",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: ["node"],
          paths: {
            "@pracht/core": [coreDistTypesPath],
            "@standard-schema/spec": [standardSchemaImportPath],
          },
        },
        files: [virtualTypesPath],
        include: ["src"],
      },
      null,
      2,
    ),
  );
}

function diagnosticsFor(appDir) {
  try {
    execFileSync(process.execPath, [tscPath, "-p", ".", "--pretty", "false"], {
      cwd: appDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    throw new Error("expected the fixture to fail typechecking");
  } catch (error) {
    return error.stdout || error.stderr || "";
  }
}

describe("<Link href> compile diagnostics", () => {
  it("names the fix instead of leaving TypeScript to guess a typo", () => {
    const appDir = createRepoTempDir("pracht-cli-link-href-guidance-");
    writeTypedManifestApp(appDir);
    runCli(["typegen"], { cwd: appDir });
    writeProjectFile(
      appDir,
      "src/link-consumer.tsx",
      `import { Link } from "@pracht/core";

export function Post() {
  return <Link href="/blog/hello">Post</Link>;
}
`,
    );
    writeTsconfig(appDir);

    const diagnostics = diagnosticsFor(appDir);

    // Without the declared prop TypeScript falls back to its own guess, which
    // sends the reader looking for a typo rather than at the API.
    expect(diagnostics).not.toContain("Did you mean 'ref'?");
    expect(diagnostics).toContain(`Type '"/blog/hello"' is not assignable to type`);
    // The whole sentence, not a `...`-truncated prefix. TypeScript elides long
    // type strings, so this also pins that the literal is short enough to print.
    expect(diagnostics).toContain(PRINTED_GUIDANCE);
  }, 120_000);

  it("catches href arriving through a spread, where <Link> would have dropped it", () => {
    const appDir = createRepoTempDir("pracht-cli-link-href-spread-");
    writeTypedManifestApp(appDir);
    runCli(["typegen"], { cwd: appDir });
    writeProjectFile(
      appDir,
      "src/link-consumer.tsx",
      `import { Link } from "@pracht/core";
import type { JSX } from "preact";

// A design-system wrapper whose own props include \`href\`. JSX does not
// excess-property-check spreads, so this used to compile and <Link> silently
// overwrote the forwarded href with the one it builds.
type ButtonLinkProps = JSX.IntrinsicElements["a"] & { route: "home" };

export function ButtonLink({ route, ...rest }: ButtonLinkProps) {
  return <Link route={route} {...rest} />;
}

// The same hole, reached through a conditional bag rather than a wrapper.
declare const maybe: { href?: string };

export function Home() {
  return <Link route="home" {...maybe}>Home</Link>;
}
`,
    );
    writeTsconfig(appDir);

    const diagnostics = diagnosticsFor(appDir);

    expect(diagnostics).toContain("src/link-consumer.tsx");
    // Both shapes are reported, and both are reported against `href` rather
    // than against some unrelated member of the props intersection.
    expect(diagnostics).toContain("Types of property 'href' are incompatible");
    expect(diagnostics).toContain(
      `Type 'string | undefined' is not assignable to type '"${PRINTED_GUIDANCE}" | undefined'`,
    );
  }, 120_000);

  it("accepts route-id navigation and the anchor attributes", () => {
    const appDir = createRepoTempDir("pracht-cli-link-href-valid-");
    writeTypedManifestApp(appDir);
    runCli(["typegen"], { cwd: appDir });
    writeProjectFile(
      appDir,
      "src/link-consumer.tsx",
      `import { Link } from "@pracht/core";

export function Nav() {
  return (
    <>
      <Link route="home" class="nav" id="home-link">Home</Link>
      <Link route="product" params={{ id: "1" }} prefetch="viewport">Product</Link>
      {/* An explicit undefined is the one thing declaring the prop makes legal. */}
      <Link route="home" href={undefined}>Home</Link>
      {/*
        Anchor-specific attributes. These live on JSX.IntrinsicElements["a"], not
        on JSX.HTMLAttributes, so basing LinkProps on the generic interface used
        to reject every one of them — there was no way to open a typed <Link> in
        a new tab without a cast.
      */}
      <Link route="home" target="_blank" rel="noopener noreferrer">New tab</Link>
      <Link route="product" params={{ id: "1" }} download hreflang="en" referrerpolicy="no-referrer">
        Download
      </Link>
    </>
  );
}
`,
    );
    writeTsconfig(appDir);

    expect(() => typecheckFixture(appDir, ["--pretty", "false"])).not.toThrow();
  }, 120_000);
});
