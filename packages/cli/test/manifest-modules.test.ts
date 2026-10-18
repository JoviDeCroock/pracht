import { describe, expect, it } from "vitest";

import {
  findUnresolvedManifestModules,
  formatUnresolvedManifestModules,
} from "../src/manifest-modules.ts";

const importer = async () => {
  throw new Error("the check must not import modules");
};

function modules(...keys: string[]): Record<string, () => Promise<unknown>> {
  return Object.fromEntries(keys.map((key) => [key, importer]));
}

describe("findUnresolvedManifestModules", () => {
  it("passes refs the registry serves, the way the runtime looks them up", async () => {
    const problems = await findUnresolvedManifestModules({
      resolvedApp: {
        routes: [
          {
            id: "home",
            path: "/",
            file: "./routes/home.tsx",
            shellFile: "./shells/public.tsx",
            middlewareFiles: ["./middleware/gate.ts"],
          },
          { id: "feature", path: "/feature", file: "./features/feature.tsx" },
        ],
        notFound: { file: "./routes/missing.tsx" },
      },
      registry: {
        routeModules: modules(
          "/src/routes/home.tsx",
          "/src/routes/missing.tsx",
          "/src/features/feature.tsx",
        ),
        shellModules: modules("/src/shells/public.tsx"),
        middlewareModules: modules("/src/middleware/gate.ts"),
      },
    });
    expect(problems).toEqual([]);
  });

  it("names each route, shell, middleware and notFound ref that matches nothing", async () => {
    const problems = await findUnresolvedManifestModules({
      resolvedApp: {
        routes: [
          {
            id: "extra",
            path: "/extra",
            file: "../routes/extra.tsx",
            shellFile: "./shells/gone.tsx",
            middlewareFiles: ["./guards/gate.ts"],
          },
        ],
        notFound: { file: "./features/missing.tsx" },
      },
      registry: {
        routeModules: modules("/src/routes/extra.tsx"),
        shellModules: modules(),
        middlewareModules: modules(),
      },
    });
    expect(problems).toEqual([
      'route "extra" (/extra): module "../routes/extra.tsx"',
      'route "extra" (/extra): shell "./shells/gone.tsx"',
      'route "extra" (/extra): middleware "./guards/gate.ts"',
      'notFound page: module "./features/missing.tsx"',
    ]);
    expect(formatUnresolvedManifestModules(problems)).toContain(
      "4 manifest module refs match no module in the build",
    );
  });

  it("checks the middleware API routes run, which no page route names", async () => {
    const problems = await findUnresolvedManifestModules({
      resolvedApp: {
        routes: [{ id: "home", path: "/", file: "./routes/home.tsx" }],
        middleware: { gate: "./guards/gone.ts", fine: "./middleware/fine.ts" },
        api: { middleware: ["gate", "fine", "undeclared"] },
      },
      registry: {
        routeModules: modules("/src/routes/home.tsx"),
        middlewareModules: modules("/src/middleware/fine.ts"),
      },
    });
    expect(problems).toEqual(['api middleware "gate": module "./guards/gone.ts"']);
  });

  it("checks nothing when the server module carries no registry", async () => {
    expect(await findUnresolvedManifestModules({})).toEqual([]);
  });
});
