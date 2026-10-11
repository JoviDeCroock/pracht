import { describe, expect, it } from "vitest";

import {
  formatMarkdownSkipList,
  injectMarkdownAlternateLink,
  markdownFileHeaders,
  markdownFileHref,
} from "../src/markdown-files.js";

describe("markdownFileHeaders", () => {
  it("serves the page's headers with the Markdown content type", () => {
    expect(
      markdownFileHeaders({
        "cache-control": "public, max-age=600",
        "content-type": "text/html; charset=utf-8",
        "content-length": "1234",
        etag: 'W/"html"',
        vary: "Accept",
        "x-frame-options": "SAMEORIGIN",
      }),
    ).toEqual({
      headers: {
        "cache-control": "public, max-age=600",
        "content-type": "text/markdown; charset=utf-8",
        vary: "Accept",
        "x-frame-options": "SAMEORIGIN",
      },
    });
  });

  it("writes no file for a page kept out of indexes or shared caches", () => {
    expect(markdownFileHeaders({ "x-robots-tag": "noindex, nofollow" })).toEqual({
      reason: "the page sends X-Robots-Tag: noindex",
    });
    expect(markdownFileHeaders({ "x-robots-tag": "googlebot: none" })).toHaveProperty("reason");
    expect(markdownFileHeaders({ "cache-control": "private, max-age=60" })).toEqual({
      reason: "the page sends Cache-Control: private, max-age=60",
    });
    expect(markdownFileHeaders({ "Cache-Control": "no-store" })).toHaveProperty("reason");
    expect(markdownFileHeaders({ "x-robots-tag": "noarchive" })).toHaveProperty("headers");
  });
});

describe("markdownFileHref", () => {
  it("puts the file under the deploy base, and at the origin root for a CDN base", () => {
    expect(markdownFileHref("/", "/about.md")).toBe("/about.md");
    expect(markdownFileHref("/docs/", "/index.md")).toBe("/docs/index.md");
    expect(markdownFileHref("/docs", "/a.md")).toBe("/docs/a.md");
    expect(markdownFileHref("./", "/a.md")).toBe("/a.md");
    expect(markdownFileHref("https://cdn.example.com/assets/", "/a.md")).toBe("/a.md");
    expect(markdownFileHref("//cdn.example.com/", "/a.md")).toBe("/a.md");
  });
});

describe("injectMarkdownAlternateLink", () => {
  it("adds the link at the end of the generated head", () => {
    const html =
      "<!DOCTYPE html>\n<html>\n  <head>\n    <title>A</title>\n  </head>\n  <body>\n</body></html>";
    expect(injectMarkdownAlternateLink(html, "/a.md")).toContain(
      '<title>A</title>\n    <link rel="alternate" type="text/markdown" href="/a.md">\n  </head>',
    );
  });

  it("marks the link as server-owned in islands-navigation documents", () => {
    const html = [
      "<!DOCTYPE html>",
      "<html>",
      "  <head>",
      '    <script data-pracht-owned type="application/json" id="pracht-nav">{}</script>',
      "  </head>",
      "  <body>",
      "</body></html>",
    ].join("\n");
    expect(injectMarkdownAlternateLink(html, "/a.md")).toContain(
      '<link data-pracht-owned rel="alternate" type="text/markdown" href="/a.md">\n  </head>',
    );
  });

  it("escapes the href", () => {
    const html = "<html><head></head><body></body></html>";
    expect(injectMarkdownAlternateLink(html, '/a"<b>&.md')).toContain(
      'href="/a&quot;&lt;b&gt;&amp;.md"',
    );
  });
});

describe("formatMarkdownSkipList", () => {
  it("names five pages and counts the rest", () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      pagePath: `/p${index}`,
      reason: "ISG route",
    }));
    expect(formatMarkdownSkipList(entries)).toBe(
      "/p0 (ISG route), /p1 (ISG route), /p2 (ISG route), /p3 (ISG route), /p4 (ISG route), and 2 more",
    );
  });
});
