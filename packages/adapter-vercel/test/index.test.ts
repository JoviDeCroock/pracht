import { describe, expect, it } from "vitest";

import { createVercelServerEntryModule } from "../src/index.ts";

describe("createVercelServerEntryModule", () => {
  it("imports an app createContext module when configured", () => {
    const source = createVercelServerEntryModule({
      createContextFrom: "/src/server/context.ts",
      functionName: "app",
      regions: ["iad1"],
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain("createContext: createPrachtContext");
    expect(source).toContain("createVercelEdgeHandler");
    expect(source).toContain('export const vercelFunctionName = "app";');
  });
});
