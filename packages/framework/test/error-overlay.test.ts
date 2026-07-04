import { describe, expect, it } from "vitest";

import {
  buildErrorOverlayHtml,
  normalizeStackFile,
  parseStackFrames,
} from "../src/error-overlay.ts";

const STACK_FIXTURE = [
  "Error: loader exploded",
  "    at loader (/Users/dev/my-app/src/routes/home.tsx:12:9)",
  "    at async handlePrachtRequest (/Users/dev/my-app/node_modules/@pracht/core/dist/index.mjs:100:5)",
  "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
].join("\n");

describe("parseStackFrames", () => {
  it("extracts file, line, and column from app frames", () => {
    const frames = parseStackFrames(STACK_FIXTURE);

    expect(frames).toHaveLength(4);
    expect(frames[1]).toMatchObject({
      file: "/Users/dev/my-app/src/routes/home.tsx",
      line: 12,
      column: 9,
      isApp: true,
    });
  });

  it("keeps the message line as a non-frame entry", () => {
    const frames = parseStackFrames(STACK_FIXTURE);

    expect(frames[0]).toMatchObject({ raw: "Error: loader exploded", isApp: false });
    expect(frames[0].file).toBeUndefined();
  });

  it("marks node_modules and node: internals as non-app frames", () => {
    const frames = parseStackFrames(STACK_FIXTURE);

    expect(frames[2].isApp).toBe(false);
    expect(frames[3].isApp).toBe(false);
  });

  it("parses bare frames without a function name", () => {
    const [frame] = parseStackFrames("    at /Users/dev/my-app/src/api/health.ts:3:1");

    expect(frame).toMatchObject({
      file: "/Users/dev/my-app/src/api/health.ts",
      line: 3,
      column: 1,
      isApp: true,
    });
  });

  it("parses async frames", () => {
    const [frame] = parseStackFrames(
      "    at async loader (/Users/dev/my-app/src/server/data.ts:8:3)",
    );

    expect(frame).toMatchObject({ file: "/Users/dev/my-app/src/server/data.ts", line: 8 });
  });

  it("resolves file:// URLs to filesystem paths", () => {
    const [frame] = parseStackFrames(
      "    at loader (file:///Users/dev/my%20app/src/routes/home.tsx:4:11)",
    );

    expect(frame).toMatchObject({
      file: "/Users/dev/my app/src/routes/home.tsx",
      line: 4,
      column: 11,
    });
  });

  it("strips Vite transform queries and /@fs/ prefixes", () => {
    const [frame] = parseStackFrames(
      "    at loader (/@fs/Users/dev/my-app/src/routes/home.tsx?t=1699999999:7:2)",
    );

    expect(frame).toMatchObject({ file: "/Users/dev/my-app/src/routes/home.tsx", line: 7 });
  });

  it("joins root-relative dev-server URLs onto the project root", () => {
    const [frame] = parseStackFrames("    at loader (/src/routes/home.tsx:5:3)", {
      root: "/Users/dev/my-app",
    });

    expect(frame).toMatchObject({ file: "/Users/dev/my-app/src/routes/home.tsx", line: 5 });
  });

  it("leaves absolute paths under the root untouched", () => {
    const [frame] = parseStackFrames("    at loader (/Users/dev/my-app/src/routes/home.tsx:5:3)", {
      root: "/Users/dev/my-app",
    });

    expect(frame.file).toBe("/Users/dev/my-app/src/routes/home.tsx");
  });

  it("does not link virtual modules or eval frames", () => {
    const frames = parseStackFrames(
      [
        "    at loader (virtual:pracht/server:1:1)",
        "    at eval (eval at run (/Users/dev/app.ts:1:1), <anonymous>:1:1)",
        "    at native",
      ].join("\n"),
    );

    for (const frame of frames) {
      expect(frame.isApp).toBe(false);
      expect(frame.file).toBeUndefined();
    }
  });
});

describe("normalizeStackFile", () => {
  it("strips queries and hashes", () => {
    expect(normalizeStackFile("/a/b.tsx?pracht-client#L1")).toBe("/a/b.tsx");
  });

  it("converts http dev-server URLs using the root", () => {
    expect(normalizeStackFile("http://localhost:3100/src/routes/home.tsx?t=1", "/proj")).toBe(
      "/proj/src/routes/home.tsx",
    );
  });

  it("handles Windows drive paths behind /@fs/", () => {
    expect(normalizeStackFile("/@fs/C:/proj/src/a.tsx")).toBe("C:/proj/src/a.tsx");
  });

  it("tolerates a trailing slash on the root", () => {
    expect(normalizeStackFile("/src/a.tsx", "/proj/")).toBe("/proj/src/a.tsx");
  });
});

describe("buildErrorOverlayHtml", () => {
  it("renders open-in-editor links for app stack frames", () => {
    const html = buildErrorOverlayHtml({
      message: "loader exploded",
      stack: STACK_FIXTURE,
      root: "/Users/dev/my-app",
    });

    expect(html).toContain('data-editor-file="/Users/dev/my-app/src/routes/home.tsx:12:9"');
    expect(html).toContain("/__open-in-editor?file=");
    expect(html).toContain('class="editor-link"');
  });

  it("de-emphasizes node_modules and internal frames without linking them", () => {
    const html = buildErrorOverlayHtml({
      message: "loader exploded",
      stack: STACK_FIXTURE,
      root: "/Users/dev/my-app",
    });

    expect(html).toContain('class="frame-internal"');
    expect(html).not.toContain('data-editor-file="/Users/dev/my-app/node_modules');
    expect(html).not.toContain('data-editor-file="node:');
  });

  it("links the file metadata to the editor", () => {
    const html = buildErrorOverlayHtml({
      message: "boom",
      file: "./routes/home.tsx",
      root: "/Users/dev/my-app",
    });

    expect(html).toContain('data-editor-file="/Users/dev/my-app/src/routes/home.tsx"');
  });

  it("falls back to plain text for the file metadata without a root", () => {
    const html = buildErrorOverlayHtml({
      message: "boom",
      file: "./routes/home.tsx",
    });

    expect(html).toContain('<span class="value">./routes/home.tsx</span>');
  });

  it("escapes HTML in messages and stack frames", () => {
    const html = buildErrorOverlayHtml({
      message: '<script>alert("xss")</script>',
      stack: 'Error: <img src=x onerror=alert(1)>\n    at loader (/app/src/"quote".tsx:1:1)',
    });

    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('data-editor-file="/app/src/&quot;quote&quot;.tsx:1:1"');
  });

  it("renders without a stack", () => {
    const html = buildErrorOverlayHtml({ message: "boom" });

    expect(html).toContain("boom");
    expect(html).not.toContain('class="stack"');
  });
});
