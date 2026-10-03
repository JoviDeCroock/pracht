import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect, it } from "vitest";

type Manifest = { peerDependencies?: Record<string, string> };

const require = createRequire(import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(path, "utf-8")) as Manifest;

// The monorepo tests against a Preact 11 release candidate, which TanStack's
// adapter does not accept: this keeps the published peer from promising more
// than an npm install of `@tanstack/preact-query` can resolve.
it("accepts only the Preact versions @tanstack/preact-query accepts", () => {
  const own = read(new URL("../package.json", import.meta.url).pathname);
  const tanstack = read(require.resolve("@tanstack/preact-query/package.json"));
  expect(own.peerDependencies?.preact).toBe(tanstack.peerDependencies?.preact);
});
