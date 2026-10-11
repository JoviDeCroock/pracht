import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Writes a minimal bundled-docs directory (the shape `scripts/sync-docs.js`
 * produces) so docs consumers can be tested without the build output.
 */
export function writeDocsFixture(dir: string): string {
  const pages = [
    {
      slug: "routing",
      title: "Routing",
      lead: "Routes are declared in a manifest.",
      section: "Getting Started",
      body: "## Route Manifest\n\nDeclare every route in the manifest.\n\n## `<Link>` props\n\nLink takes a route id.\n",
    },
    {
      slug: "data-loading",
      title: "Data Loading",
      lead: "Loaders run on the server.",
      section: "Core",
      body: "## Loaders\n\nA loader runs on the server.\n",
    },
  ];
  mkdirSync(dir, { recursive: true });
  for (const page of pages) {
    writeFileSync(
      join(dir, `${page.slug}.md`),
      `---\ntitle: ${JSON.stringify(page.title)}\nlead: ${JSON.stringify(page.lead)}\nurl: https://pracht.resynapse.dev/docs/${page.slug}\n---\n\n${page.body}`,
    );
  }
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      site: "https://pracht.resynapse.dev",
      pages: pages.map(({ slug, title, lead, section }) => ({
        slug,
        path: `/docs/${slug}`,
        url: `https://pracht.resynapse.dev/docs/${slug}`,
        title,
        lead,
        section,
      })),
    }),
  );
  return dir;
}
