import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Marked, Renderer } from "marked";
import { afterEach, describe, expect, it } from "vitest";

import { defineMarkdownCollection } from "../src/index.ts";
import { renderMarkdownImage, renderMarkdownImages } from "../src/runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(markdown: string) {
  const root = await mkdtemp(join(tmpdir(), "pracht-markdown-"));
  roots.push(root);
  const source = join(root, "post.md");
  await writeFile(source, markdown);
  const collection = defineMarkdownCollection({ name: "test", root });
  return { collection, source };
}

describe("defineMarkdownCollection", () => {
  it("imports relative images once and leaves public and remote sources untouched", async () => {
    const { collection, source } = await fixture(
      [
        '![First](./photo.jpg "A title")',
        "![Again][photo]",
        "![Public](/photo.jpg)",
        "![Remote](https://example.com/photo.jpg)",
        "",
        "[photo]: ./photo.jpg",
      ].join("\n"),
    );

    const document = await collection.loadSource(source);
    expect(document.compiled.images).toHaveLength(2);
    expect(document.compiled.html).toContain("__PRACHT_MARKDOWN_IMAGE_0_");
    expect(document.compiled.html).toContain('src="/photo.jpg"');
    expect(document.compiled.html).toContain('src="https://example.com/photo.jpg"');

    const module = await collection.renderModule(source);
    expect(module?.match(/photo\.jpg\?pracht&pracht-static/g)).toHaveLength(1);
    expect(module).toContain("renderMarkdownImages");
  });

  it("anchors bare relative image paths so Vite does not resolve them as packages", async () => {
    const { collection, source } = await fixture("![Alt](photo.jpg)\n![Nested](sub/photo.jpg)\n");

    const module = await collection.renderModule(source);
    expect(module).toContain('from "./photo.jpg?pracht&pracht-static"');
    expect(module).toContain('from "./sub/photo.jpg?pracht&pracht-static"');
  });

  it("preserves custom image renderers for unprocessed sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-markdown-"));
    roots.push(root);
    const source = join(root, "post.md");
    await writeFile(source, "![Public](/photo.jpg)\n![Remote](https://example.com/photo.jpg)\n");
    const renderer = new Renderer();
    renderer.image = (token) => `<figure data-source="${token.href}">${token.text}</figure>`;
    const collection = defineMarkdownCollection({
      name: "test",
      root,
      createMarked: () => new Marked({ renderer }),
    });

    const document = await collection.loadSource(source);

    expect(document.compiled.images).toHaveLength(0);
    expect(document.compiled.html).toContain('<figure data-source="/photo.jpg">Public</figure>');
    expect(document.compiled.html).toContain(
      '<figure data-source="https://example.com/photo.jpg">Remote</figure>',
    );
  });

  it("keeps image markers stable across checkout roots", async () => {
    const first = await fixture("![Alt](./photo.jpg)");
    const second = await fixture("![Alt](./photo.jpg)");

    const firstDocument = await first.collection.loadSource(first.source);
    const secondDocument = await second.collection.loadSource(second.source);

    expect(firstDocument.compiled.images[0].marker).toBe(secondDocument.compiled.images[0].marker);
  });

  it("resolves image markers once at module scope instead of on every render", async () => {
    const { collection, source } = await fixture("![Alt](./photo.jpg)");

    const module = await collection.renderModule(source);
    expect(module).toContain("const __prachtHtml = renderMarkdownImages(");
    expect(module).toContain("__html: __prachtHtml");
  });

  it("rejects local query strings instead of ambiguously merging Vite queries", async () => {
    const { collection, source } = await fixture("![Bad](./photo.jpg?width=10)");
    await expect(collection.loadSource(source)).rejects.toThrow(/cannot contain query strings/);
  });

  it("titles the page from frontmatter when no head() hook is configured", async () => {
    const { collection, source } = await fixture("---\ntitle: My Post\n---\nBody");

    expect(await collection.renderModule(source)).toContain('return {"title":"My Post"};');
  });

  it("leaves the head empty without a title and lets an explicit hook win", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-markdown-"));
    roots.push(root);
    const source = join(root, "post.md");
    await writeFile(source, "---\ntitle: Frontmatter\n---\nBody");

    const untitled = defineMarkdownCollection({ name: "untitled", root });
    const hooked = defineMarkdownCollection({
      name: "hooked",
      root,
      head: () => ({ title: "Explicit" }),
    });

    await writeFile(source, "Body only");
    expect(await untitled.renderModule(source)).toContain("return {};");
    await writeFile(source, "---\ntitle: Frontmatter\n---\nBody");
    expect(await hooked.renderModule(source)).toContain('return {"title":"Explicit"};');
  });
});

describe("renderMarkdownImage", () => {
  it("renders static variants and escapes author-controlled attributes", () => {
    const html = renderMarkdownImage(
      {
        source: "./photo.jpg",
        alt: 'A <photo> & "caption"',
        title: 'Title "quoted"',
        marker: "marker",
      },
      {
        src: "/assets/photo.640.webp",
        width: 640,
        height: 400,
        variants: [
          { src: "/assets/photo.320.webp", width: 320, type: "image/webp" },
          { src: "/assets/photo.640.webp", width: 640, type: "image/webp" },
        ],
      },
    );

    expect(html).toContain('src="/assets/photo.640.webp"');
    expect(html).toContain("/assets/photo.320.webp 320w");
    expect(html).toContain('width="640"');
    expect(html).toContain('height="400"');
    expect(html).toContain('alt="A &lt;photo&gt; &amp; &quot;caption&quot;"');
    expect(html).toContain('title="Title &quot;quoted&quot;"');
  });

  it("keeps dollar patterns in alt text out of the replacement grammar", () => {
    const html = renderMarkdownImages(
      "<p>marker</p>",
      [{ source: "./photo.jpg", alt: "Save $& win $` now $'", marker: "marker" }],
      [{ src: "/photo.jpg", width: 10, height: 10 }],
    );

    expect(html).toContain(`alt="Save $&amp; win $\` now $'"`);
    expect(html).not.toContain("marker");
  });

  it("fails closed when compiled image markers are missing or duplicated", () => {
    const descriptor = { source: "./photo.jpg", alt: "Photo", marker: "marker" };
    const metadata = { src: "/photo.jpg", width: 10, height: 10 };

    expect(() => renderMarkdownImages("absent", [descriptor], [metadata])).toThrow(/found 0/);
    expect(() => renderMarkdownImages("marker marker", [descriptor], [metadata])).toThrow(
      /found 2/,
    );
  });
});
