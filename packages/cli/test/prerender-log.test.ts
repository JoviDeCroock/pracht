import { describe, expect, it } from "vitest";

import { planPrerenderLog } from "../src/commands/build.ts";

// One line per prerendered page turned a content site's build into 5,000 lines
// of scrollback. The build names the first few and elides the rest — but the
// elided count has to agree with the total printed on the line above, and the
// tail must not appear when nothing was elided.
describe("planPrerenderLog", () => {
  it("names every page and adds no tail below the limit", () => {
    expect(planPrerenderLog(0, 20)).toEqual({ named: 0, tail: null });
    expect(planPrerenderLog(1, 20)).toEqual({ named: 1, tail: null });
    expect(planPrerenderLog(19, 20)).toEqual({ named: 19, tail: null });
  });

  it("adds no tail at exactly the limit", () => {
    expect(planPrerenderLog(20, 20)).toEqual({ named: 20, tail: null });
  });

  it("elides one page at one over the limit", () => {
    expect(planPrerenderLog(21, 20)).toEqual({ named: 20, tail: "    … and 1 more" });
  });

  it("counts the elided pages, not the total", () => {
    expect(planPrerenderLog(500, 20)).toEqual({ named: 20, tail: "    … and 480 more" });
  });

  // The limit is a parameter rather than a captured constant, so retuning
  // PRERENDER_LOG_LIMIT cannot quietly change what this pins.
  it("honours a different limit", () => {
    expect(planPrerenderLog(500, 5)).toEqual({ named: 5, tail: "    … and 495 more" });
    expect(planPrerenderLog(500, 0)).toEqual({ named: 0, tail: "    … and 500 more" });
  });
});
