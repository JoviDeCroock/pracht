import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  coreDistTypesPath,
  createRepoTempDir,
  runCli,
  standardSchemaImportPath,
  typecheckFixture,
  virtualTypesPath,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli typegen search types", () => {
  it("types link search against a route's schema input and useSearch() against its output", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-search-types-");
    writeTypedManifestApp(appDir);
    writeProjectFile(
      appDir,
      "src/routes.ts",
      `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [
    route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
    route("/products/:id", "./routes/product.tsx", { id: "product", render: "ssr" }),
    route("/catalog", "./routes/catalog.tsx", { id: "catalog", render: "ssr" }),
    route("/report", "./routes/report.tsx", { id: "report", render: "ssr" }),
    route("/numbers", "./routes/numbers.tsx", { id: "numbers", render: "ssr" }),
  ],
});
`,
    );
    // Optional keys with a coercing (opaque) input, a string, and a repeated key.
    writeProjectFile(
      appDir,
      "src/routes/catalog.tsx",
      `import type { LoaderArgs, SearchArgs } from "@pracht/core";
import { passthroughSchema } from "../lib/schema-util";

export const search = passthroughSchema<
  { page?: unknown; q?: string; tag?: string[] },
  { page: number; q?: string; tag: string[] }
>();

export function loader(args: LoaderArgs & SearchArgs<typeof search>) {
  const page: number = args.search.page;
  return { page };
}

export function Component() { return null; }
`,
    );
    // A required key makes \`search\` itself required.
    writeProjectFile(
      appDir,
      "src/routes/report.tsx",
      `import { passthroughSchema } from "../lib/schema-util";

export const search = passthroughSchema<{ from: string }, { from: Date }>();

export function Component() { return null; }
`,
    );
    // An input with no string representation can never validate from a URL.
    writeProjectFile(
      appDir,
      "src/routes/numbers.tsx",
      `import { passthroughSchema } from "../lib/schema-util";

export const search = passthroughSchema<{ n?: number }>();

export function Component() { return null; }
`,
    );
    runCli(["typegen"], { cwd: appDir });

    const declaration = readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8");
    expect(declaration).toContain('search: RouteSearchInput<typeof import("./routes/catalog")>;');
    expect(declaration).toContain(
      'searchOutput: RouteSearchOutput<typeof import("./routes/catalog")>;',
    );

    writeProjectFile(
      appDir,
      "src/search-consumer.tsx",
      `import { Link, useNavigate, useRouteData, useSearch } from "@pracht/core";
import { href } from "./pracht-routes";

export function Catalog() {
  // The schema output, keyed by route id.
  const search = useSearch("catalog");
  const _page: number = search.page;
  const _tags: string[] = search.tag;
  // @ts-expect-error - the output page is a number, not the raw string
  const _rawPage: string = search.page;

  const report = useSearch("report");
  const _from: Date = report.from;

  // Routes without a schema read the raw query record.
  const home = useSearch("home");
  const _home: Record<string, string | string[]> = home;

  const data = useRouteData("catalog");
  const _data: { page: number } = data;

  const navigate = useNavigate();
  void navigate({ route: "catalog", search: { page: 2, q: "boots", tag: ["a", "b"] } });
  // @ts-expect-error - keys outside the schema input are rejected
  void navigate({ route: "catalog", search: { pgae: 2 } });
  // @ts-expect-error - a string input does not accept a number
  void navigate({ route: "catalog", search: { q: 1 } });

  href("catalog");
  href("catalog", { search: { page: 3 } });
  href("report", { search: { from: "2026-01-01" } });
  // @ts-expect-error - report's schema has a required key, so search is required
  href("report");
  // @ts-expect-error - a number-only input can never validate from a URL
  href("numbers", { search: { n: 1 } });
  // Routes without a schema keep the untyped SearchParamsInput.
  href("home", { search: "a=1" });
  href("product", { params: { id: "1" }, search: { ref: "home", tags: ["x"] } });

  return (
    <>
      <Link route="catalog" search={{ page: 2 }}>Next</Link>
      <Link route="report" search={{ from: "2026-01-01" }}>Report</Link>
      {/* @ts-expect-error - required search is missing */}
      <Link route="report">Report</Link>
      {/* @ts-expect-error - keys outside the schema input are rejected */}
      <Link route="catalog" search={{ sort: "asc" }}>Sorted</Link>
    </>
  );
}
`,
    );
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
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            jsx: "react-jsx",
            jsxImportSource: "preact",
            types: ["node", "vite/client"],
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

    // Throws with the compiler output when a type assertion above is wrong,
    // including an unused @ts-expect-error.
    typecheckFixture(appDir);
  }, 120_000);
});
