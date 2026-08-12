import { describe, expect, it } from "vitest";

import { transformAppManifestModule } from "../src/plugin-manifest-transform.ts";

const options = { appFile: "/src/routes.ts", root: "/project" };

describe("app manifest transform", () => {
  it("converts lazy module references and redirects manifest-only imports", () => {
    const result = transformAppManifestModule(
      [
        'import { defineApp, route } from "@pracht/core";',
        'export default defineApp({ routes: [route("/", () => import("./routes/home.tsx"))] });',
      ].join("\n"),
      "/project/src/routes.ts?import",
      options,
    );

    expect(result?.code).toContain('from "@pracht/core/manifest"');
    expect(result?.code).toContain('route("/", "./routes/home.tsx")');
  });

  it("keeps root imports when they include browser or server helpers", () => {
    const result = transformAppManifestModule(
      'import { defineApp, createHref } from "@pracht/core";',
      "/project/src/routes.ts",
      options,
    );

    expect(result).toBeNull();
  });

  it("ignores modules other than the configured manifest", () => {
    const result = transformAppManifestModule(
      'const route = () => import("./home.tsx");',
      "/project/src/other.ts",
      options,
    );

    expect(result).toBeNull();
  });
});
