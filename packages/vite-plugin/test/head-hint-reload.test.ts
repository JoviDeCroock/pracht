import { describe, expect, it } from "vitest";

import { reachesHeadBearingModule, type HotUpdateModuleLike } from "../src/head-hint-reload.ts";

const ROOT = "/app";
const HINTS = { "/src/routes/greeting.tsx": true, "/src/routes/pricing.tsx": false };

function mod(file: string, importers: HotUpdateModuleLike[] = []): HotUpdateModuleLike {
  return { file, importers: new Set(importers) };
}

describe("reachesHeadBearingModule", () => {
  it("reports a head-bearing module reached through its importers", () => {
    const fonts = mod("/app/src/fonts.ts", [mod("/app/src/routes/greeting.tsx")]);

    expect(reachesHeadBearingModule([fonts], ROOT, HINTS)).toBe(true);
  });

  it("reports the changed module itself by default", () => {
    expect(reachesHeadBearingModule([mod("/app/src/routes/greeting.tsx")], ROOT, HINTS)).toBe(true);
  });

  // Editing a route that exports `head` is not a head *change*: the hint the
  // virtual client entry bakes is only whether the export exists. Counting the
  // module itself made every edit to such a route a full page reload, which is
  // most routes.
  it("skips the changed module itself when it is a route source", () => {
    expect(
      reachesHeadBearingModule([mod("/app/src/routes/greeting.tsx")], ROOT, HINTS, {
        startAtImporters: true,
      }),
    ).toBe(false);
  });

  // A shared module inside src/routes that a head-bearing route imports still
  // has to reload — its font/preload state lives in the virtual entry.
  it("still walks importers when skipping the changed module", () => {
    const shared = mod("/app/src/routes/_shared.tsx", [mod("/app/src/routes/greeting.tsx")]);

    expect(reachesHeadBearingModule([shared], ROOT, HINTS, { startAtImporters: true })).toBe(true);
  });

  it("returns false when nothing in the graph exports head", () => {
    expect(reachesHeadBearingModule([mod("/app/src/routes/pricing.tsx")], ROOT, HINTS)).toBe(false);
  });

  it("terminates on an import cycle", () => {
    const a: HotUpdateModuleLike = { file: "/app/src/a.ts", importers: new Set() };
    const b: HotUpdateModuleLike = { file: "/app/src/b.ts", importers: new Set([a]) };
    a.importers!.add(b);

    expect(reachesHeadBearingModule([a], ROOT, HINTS)).toBe(false);
  });

  it("strips a query from the module id when no file is set", () => {
    expect(
      reachesHeadBearingModule(
        [{ id: "/app/src/routes/greeting.tsx?pracht-client", importers: new Set() }],
        ROOT,
        HINTS,
      ),
    ).toBe(true);
  });
});
