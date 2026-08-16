import { createHash } from "node:crypto";
import { defineCollection, type ContentCompileInput } from "@pracht/content";
import { Marked } from "marked";
import type { Tokens } from "marked";

import type {
  CompiledMarkdown,
  DefineMarkdownCollectionOptions,
  MarkdownImageDescriptor,
} from "./types.ts";

export type {
  CompiledMarkdown,
  DefineMarkdownCollectionOptions,
  MarkdownImageDescriptor,
  MarkdownImageOptions,
  MarkdownRenderContext,
} from "./types.ts";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rawImage(token: Tokens.Image): string {
  const title = token.title == null ? "" : ` title="${escapeAttribute(token.title)}"`;
  return `<img src="${escapeAttribute(token.href)}" alt="${escapeAttribute(token.text)}"${title}>`;
}

function localImageSource(href: string, source: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURI(href);
  } catch {
    throw new Error(
      `[pracht/markdown] Invalid encoded image path ${JSON.stringify(href)} in ${JSON.stringify(source)}.`,
    );
  }
  if (decoded.startsWith("/") || decoded.startsWith("#") || URL.canParse(decoded)) return undefined;
  if (decoded.includes("?") || decoded.includes("#")) {
    throw new Error(
      `[pracht/markdown] Local image paths cannot contain query strings or fragments: ${JSON.stringify(href)} in ${JSON.stringify(source)}.`,
    );
  }
  // `![Alt](photo.jpg)` is ordinary Markdown, but `import "photo.jpg?…"` is a
  // bare specifier that Vite resolves through node_modules. Anchor every
  // relative source so the generated module imports the sibling file.
  return decoded.startsWith(".") ? decoded : `./${decoded}`;
}

async function compileMarkdown<TFrontmatter extends Record<string, unknown>>(
  input: ContentCompileInput<TFrontmatter>,
  options: DefineMarkdownCollectionOptions<TFrontmatter>,
): Promise<CompiledMarkdown> {
  const images: MarkdownImageDescriptor[] = [];
  const marked = options.createMarked?.() ?? new Marked();
  marked.use({
    renderer: {
      image(token) {
        const local = localImageSource(token.href, input.source);
        if (local === undefined) return rawImage(token);
        const index = images.length;
        const digest = createHash("sha256")
          .update(input.source)
          .update("\0")
          .update(local)
          .update("\0")
          .update(String(index))
          .digest("hex")
          .slice(0, 12);
        const marker = `__PRACHT_MARKDOWN_IMAGE_${index}_${digest}__`;
        images.push({
          source: local,
          alt: token.text,
          ...(token.title == null ? {} : { title: token.title }),
          marker,
        });
        return marker;
      },
    },
  });

  const parsed = await marked.parse(input.body);
  const context = { html: parsed, input };
  const rendered = options.render ? await options.render(context) : parsed;
  const head = options.head ? await options.head(context) : undefined;
  return {
    html: rendered,
    images,
    ...(head === undefined ? {} : { head }),
  };
}

function moduleCode<TFrontmatter extends Record<string, unknown>>(
  document: ContentCompileInput<TFrontmatter> & { compiled: CompiledMarkdown },
  options: DefineMarkdownCollectionOptions<TFrontmatter>,
): string {
  const uniqueSources = [...new Set(document.compiled.images.map((image) => image.source))];
  const imports = uniqueSources.map(
    (source, index) =>
      `import __prachtImage${index} from ${JSON.stringify(`${source}?pracht&pracht-static`)};`,
  );
  const metadata = document.compiled.images.map(
    (image) => `__prachtImage${uniqueSources.indexOf(image.source)}`,
  );
  const lines = [`import { h } from "preact";`];
  if (imports.length > 0) {
    lines.push(`import { renderMarkdownImages } from "@pracht/markdown/runtime";`, ...imports);
  }
  lines.push(
    ``,
    `export const markdown = ${JSON.stringify(document.raw)};`,
    ``,
    `export function head() {`,
    `  return ${JSON.stringify(document.compiled.head ?? {})};`,
    `}`,
    ``,
  );
  const html = imports.length
    ? `renderMarkdownImages(${JSON.stringify(document.compiled.html)}, ${JSON.stringify(document.compiled.images)}, [${metadata.join(", ")}], ${JSON.stringify(options.images ?? {})})`
    : JSON.stringify(document.compiled.html);
  // Resolve the markup once at module evaluation: the compiled HTML and the
  // image metadata are constants, so re-running the marker substitution on
  // every SSR render would repeat the work and defer its validation errors
  // into the middle of a response.
  lines.push(
    `const __prachtHtml = ${html};`,
    ``,
    `export function Component() {`,
    `  return h("div", { class: "pracht-markdown", dangerouslySetInnerHTML: { __html: __prachtHtml } });`,
    `}`,
  );
  return lines.join("\n");
}

/** Define a content collection whose Markdown routes share one image-aware compiler. */
export function defineMarkdownCollection<
  TFrontmatter extends Record<string, unknown> = Record<string, unknown>,
>(options: DefineMarkdownCollectionOptions<TFrontmatter>) {
  return defineCollection<TFrontmatter, CompiledMarkdown>({
    name: options.name,
    root: options.root,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    extensions: options.extensions ?? [".md", ".markdown"],
    ...(options.routeBase === undefined ? {} : { routeBase: options.routeBase }),
    ...(options.route === undefined ? {} : { route: options.route }),
    ...(options.locales === undefined ? {} : { locales: options.locales }),
    ...(options.parse === undefined ? {} : { parse: options.parse }),
    compile: (input) => compileMarkdown(input, options),
    module: (document) => moduleCode(document, options),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
  });
}
