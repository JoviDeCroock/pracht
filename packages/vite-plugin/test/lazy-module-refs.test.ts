import { describe, expect, it } from "vitest";

import { stringifyLazyModuleRefs } from "../src/lazy-module-refs.ts";

describe("stringifyLazyModuleRefs", () => {
  it("turns every lazy ref in the app manifest into a string", () => {
    expect(
      stringifyLazyModuleRefs(
        `route("/", () => import("./routes/home.tsx"));\nconst shell = () => import('./shells/app.tsx');`,
      ),
    ).toBe(`route("/", "./routes/home.tsx");\nconst shell = './shells/app.tsx';`);
  });

  it("keeps executable lazy helpers in a module the manifest imports", () => {
    const code = [
      `export const agents = { mcp: { auth: { verify: () => import("./verify.ts") } } };`,
      `export const more = [route("/a", () => import("./a.tsx")), () => import("./b.tsx")];`,
      `const load = () => import("./data.ts");`,
      `const Page = lazy(() => import("./Page.tsx"));`,
    ].join("\n");

    expect(stringifyLazyModuleRefs(code, { refPositionsOnly: true })).toBe(
      [
        `export const agents = { mcp: { auth: { verify: "./verify.ts" } } };`,
        `export const more = [route("/a", "./a.tsx"), "./b.tsx"];`,
        `const load = () => import("./data.ts");`,
        `const Page = lazy(() => import("./Page.tsx"));`,
      ].join("\n"),
    );
  });
});
