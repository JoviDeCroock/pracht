import { describe, expect, it } from "vitest";

import { createMarkdownManifest } from "../src/commands/build.ts";

describe("createMarkdownManifest", () => {
  it("rejects an alias that collides with a literal route outside the Markdown manifest", () => {
    expect(() =>
      createMarkdownManifest(
        [{ markdown: true, path: "/guide" }],
        [
          { path: "/guide", segments: [{ type: "static", value: "guide" }] },
          { path: "/guide.md", segments: [{ type: "static", value: "guide.md" }] },
        ],
      ),
    ).toThrow(
      'Markdown alias "/guide.md" for "/guide" collides with the declared route "/guide.md".',
    );
  });

  it("does not treat dynamic route patterns as literal alias collisions", () => {
    expect(
      createMarkdownManifest(
        [{ markdown: true, path: "/guide/example" }],
        [
          {
            path: "/guide/:slug.md",
            segments: [
              { type: "static", value: "guide" },
              { type: "param", name: "slug.md" },
            ],
          },
        ],
      ),
    ).toEqual({
      "/guide/example": true,
      "/guide/example.md": "/guide/example",
    });
  });
});
