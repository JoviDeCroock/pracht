import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import type { ResolvedRoute } from "../src/types.ts";

describe("handlePrachtRequest with an authoring-shaped app", () => {
  it("resolves the manifest once, not on every request", async () => {
    const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });
    const seen: ResolvedRoute[] = [];
    const registry = {
      routeModules: {
        "./routes/home.tsx": async () => ({
          Component: () => null,
          loader: ({ route: current }: { route: ResolvedRoute }) => {
            seen.push(current);
            return {};
          },
        }),
      },
    };

    for (let request = 0; request < 2; request += 1) {
      await handlePrachtRequest({ app, registry, request: new Request("http://localhost/") });
    }

    expect(seen).toHaveLength(2);
    // Both requests matched against the same resolved route table.
    expect(seen[1]).toBe(seen[0]);
  });

  it("resolves a different app object on its own", async () => {
    const seen: string[] = [];
    for (const title of ["one", "two"]) {
      await handlePrachtRequest({
        app: defineApp({ routes: [route("/", "./routes/home.tsx", { id: title })] }),
        registry: {
          routeModules: {
            "./routes/home.tsx": async () => ({
              Component: () => null,
              loader: ({ route: current }: { route: ResolvedRoute }) => {
                seen.push(current.id!);
                return {};
              },
            }),
          },
        },
        request: new Request("http://localhost/"),
      });
    }

    expect(seen).toEqual(["one", "two"]);
  });
});
