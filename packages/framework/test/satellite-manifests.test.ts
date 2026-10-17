/**
 * Packages that run inside an app share the app's `@pracht/core`. A hard
 * `dependency` is published as `^0.x`, which stops at the minor, so the first
 * core minor the app upgrades to would nest a second core under the package
 * and split the module-scoped request state.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SATELLITES = [
  "adapter-cloudflare",
  "adapter-netlify",
  "adapter-node",
  "adapter-static",
  "adapter-vercel",
  "i18n",
  "query",
  "session",
  "test",
];

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

describe.each(SATELLITES)("packages/%s/package.json", (dir) => {
  const manifest = JSON.parse(
    readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8"),
  ) as Manifest;

  it("takes @pracht/core as a peer, not a dependency", () => {
    expect(manifest.dependencies?.["@pracht/core"]).toBeUndefined();
    expect(manifest.peerDependencies?.["@pracht/core"]).toBe("workspace:^");
  });
});
