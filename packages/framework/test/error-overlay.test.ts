import { describe, expect, it } from "vitest";

import {
  buildErrorOverlayHtml,
  normalizeStackFile,
  parseStackFrames,
  stripAnsi,
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
    expect(html).toContain('fetch("/__open-in-editor" + "?file="');
    expect(html).toContain('class="editor-link"');
  });

  it("uses the deploy base for Vite's open-in-editor endpoint", () => {
    const html = buildErrorOverlayHtml({
      base: "/app/",
      message: "loader exploded",
      stack: STACK_FIXTURE,
      root: "/Users/dev/my-app",
    });

    expect(html).toContain('fetch("/app/__open-in-editor" + "?file="');
    expect(html).not.toContain('fetch("/__open-in-editor" + "?file="');
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

describe("terminal colour codes", () => {
  // oxc/esbuild colourize their diagnostics for a terminal. The browser has no
  // terminal: left in place, every character of the offending source line is
  // wrapped in its own escape sequence and the error is unreadable.
  const ESC = "\u001b";
  const ANSI_PARSE_ERROR = [
    `${ESC}[31m[PARSE_ERROR] ${ESC}[0mExpected a semicolon`,
    `    ${ESC}[38;5;246m|${ESC}[0m src/routes/pricing.tsx:20:5`,
  ].join("\n");

  it("strips escape sequences from the message", () => {
    expect(stripAnsi(ANSI_PARSE_ERROR)).toBe(
      ["[PARSE_ERROR] Expected a semicolon", "    | src/routes/pricing.tsx:20:5"].join("\n"),
    );
  });

  it("leaves text without escape sequences untouched", () => {
    expect(stripAnsi("loader exploded at [1] of the list")).toBe(
      "loader exploded at [1] of the list",
    );
  });

  it("renders a colourized compiler diagnostic without escape sequences", () => {
    const html = buildErrorOverlayHtml({ message: ANSI_PARSE_ERROR });

    expect(html).not.toContain(ESC);
    expect(html).not.toContain("[38;5;246m");
    expect(html).toContain("[PARSE_ERROR] Expected a semicolon");
  });

  it("strips escape sequences from the stack as well", () => {
    const html = buildErrorOverlayHtml({
      message: "boom",
      stack: `Error: boom\n    at ${ESC}[36mloader${ESC}[0m (/app/src/routes/home.tsx:1:1)`,
    });

    expect(html).not.toContain(ESC);
    expect(html).toContain("/app/src/routes/home.tsx");
  });

  it("preserves multi-line diagnostics in the rendered message", () => {
    const html = buildErrorOverlayHtml({ message: "line one\nline two" });

    expect(html).toContain("white-space: pre-wrap");
    expect(html).toContain("line one\nline two");
  });
});

describe("route metadata rows", () => {
  it("names the failing phase, route file, loader, and shell", () => {
    const html = buildErrorOverlayHtml({
      message: "loader exploded",
      phase: "loader",
      routeId: "blog-slug",
      file: "./routes/blog/[slug].tsx",
      loaderFile: "./server/blog-loader.ts",
      shellFile: "./shells/public.tsx",
      root: "/app",
    });

    expect(html).toContain('>Phase</span> <span class="value">loader<');
    expect(html).toContain("blog-slug");
    expect(html).toContain("./routes/blog/[slug].tsx");
    expect(html).toContain("./server/blog-loader.ts");
    expect(html).toContain("./shells/public.tsx");
    expect(html).toContain('data-editor-file="/app/src/server/blog-loader.ts"');
  });

  it("omits the loader row when the loader is the route file itself", () => {
    const html = buildErrorOverlayHtml({
      message: "loader exploded",
      file: "./routes/home.tsx",
      loaderFile: "./routes/home.tsx",
    });

    expect(html).not.toContain(">Loader</span>");
  });

  it("omits every optional row when nothing is known", () => {
    const html = buildErrorOverlayHtml({ message: "boom" });

    expect(html).not.toContain(">Phase</span>");
    expect(html).not.toContain(">Route</span>");
    expect(html).not.toContain(">Shell</span>");
  });
});

describe("escape sequences the naive pattern gets wrong", () => {
  const ESC = "\u001b";
  const BEL = "\u0007";

  // miette — and therefore oxc — emits OSC 8 terminal hyperlinks for
  // diagnostic codes. Matching them with the CSI branch stops at the first
  // letter of the URL and eats it, leaving `ttps://…` plus a stray terminator.
  it("strips an OSC 8 hyperlink without eating the URL text", () => {
    const link = `${ESC}]8;;https://oxc.rs/docs/E0001${BEL}E0001${ESC}]8;;${BEL}`;

    expect(stripAnsi(`see ${link} for details`)).toBe("see E0001 for details");
  });

  it("strips an OSC sequence terminated by ESC backslash", () => {
    expect(stripAnsi(`a${ESC}]0;window title${ESC}\\b`)).toBe("ab");
  });

  // `ESC [ 3 ~` is a complete sequence; omitting `~` from the final-byte class
  // leaves a stray tilde in the rendered message.
  it("strips a CSI sequence whose final byte is a tilde", () => {
    expect(stripAnsi(`a${ESC}[3~b`)).toBe("ab");
  });

  it("leaves a lone escape introducer alone rather than eating the next word", () => {
    expect(stripAnsi(`unterminated ${ESC}`)).toBe(`unterminated ${ESC}`);
  });

  it("does not touch bracket-heavy prose", () => {
    expect(stripAnsi("expected [1] but got (2) at #3; ok?")).toBe(
      "expected [1] but got (2) at #3; ok?",
    );
  });
});

describe("overlay auto-reload script", () => {
  // `import.meta` is a parse error in a classic script, so the whole block was
  // silently dropped and the overlay never reloaded itself after the file was
  // fixed.
  it("declares the import.meta.hot block as a module", () => {
    const html = buildErrorOverlayHtml({ message: "boom" });

    expect(html).toMatch(/<script type="module">(?:(?!<\/script>)[\s\S])*import\.meta\.hot/);
  });
});
