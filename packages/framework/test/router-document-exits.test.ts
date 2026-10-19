// @vitest-environment jsdom
import { afterEach, describe } from "vitest";

import { defineExitTable } from "./router-exit-table.ts";
import { teardownRouterHarness } from "./router-harness.ts";

describe("navigate() document exits", () => {
  afterEach(teardownRouterHarness);
  defineExitTable(["push", "replace", "popstate"]);
});
