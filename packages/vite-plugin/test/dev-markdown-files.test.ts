import { describe, expect, it } from "vitest";

import { findDevMarkdownFile } from "../src/plugin-dev-ssr.ts";

describe("findDevMarkdownFile", () => {
  const plan = {
    files: [
      { markdownPath: "/index.md", pagePath: "/", source: "# Home\n" },
      { markdownPath: "/posts/caf%C3%A9.md", pagePath: "/posts/caf%C3%A9", source: "# Café\n" },
    ],
  };

  it("finds only planned files, matching encoded and decoded spellings", () => {
    expect(findDevMarkdownFile(plan, "/index.md")?.pagePath).toBe("/");
    expect(findDevMarkdownFile(plan, "/posts/caf%C3%A9.md")?.source).toBe("# Café\n");
    expect(findDevMarkdownFile(plan, "/posts/café.md")?.source).toBe("# Café\n");
    expect(findDevMarkdownFile(plan, "/INDEX.md")).toBeUndefined();
    expect(findDevMarkdownFile(plan, "/posts/other.md")).toBeUndefined();
    expect(findDevMarkdownFile(plan, "/%E0%A4%A.md")).toBeUndefined();
  });
});
