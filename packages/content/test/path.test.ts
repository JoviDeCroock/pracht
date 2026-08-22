import { win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { relativePathEscapesRoot } from "../src/path.ts";

describe("content source paths", () => {
  it("recognizes another Windows drive as outside the collection root", () => {
    const fromRoot = win32.relative("C:\\site\\content", "D:\\secrets\\private.md");

    expect(fromRoot).toBe("D:\\secrets\\private.md");
    expect(relativePathEscapesRoot(fromRoot, win32.isAbsolute, win32.sep)).toBe(true);
  });
});
