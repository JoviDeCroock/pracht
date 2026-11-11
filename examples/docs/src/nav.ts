/**
 * The docs table of contents: one source for the sidebar, the breadcrumb, the
 * previous/next links, the llms.txt sections, the docs MCP `docs_list` tool,
 * and the section each page gets in `pracht docs` (`packages/cli/scripts/docs-bundle.js`
 * reads this file as text, so keep `label:` and `href:` as plain string literals).
 *
 * Every page under `src/routes/docs/` must appear here exactly once;
 * `test/site-content.test.ts` enforces it.
 */

export type NavIcon =
  | "activity"
  | "adjustments"
  | "apps"
  | "bolt"
  | "book"
  | "brand-cloudflare"
  | "brand-nodejs"
  | "broadcast"
  | "checklist"
  | "cloud"
  | "code"
  | "file-export"
  | "file-text"
  | "folders"
  | "forms"
  | "gauge"
  | "heading"
  | "history"
  | "key"
  | "language"
  | "layout"
  | "lock"
  | "palette"
  | "photo"
  | "plug"
  | "presentation"
  | "refresh"
  | "robot"
  | "rocket"
  | "route"
  | "server"
  | "shield"
  | "shield-check"
  | "sitemap"
  | "sparkles"
  | "terminal"
  | "test"
  | "triangle"
  | "typography"
  | "user-bolt"
  | "webhook"
  | "world"
  | "world-bolt";

export interface NavLink {
  href: string;
  title: string;
  icon: NavIcon;
}

export interface NavSection {
  label: string;
  /** The section's full-text file, linked from llms.txt. */
  llms: string;
  links: readonly NavLink[];
}

export const NAV: readonly NavSection[] = [
  {
    label: "Get started",
    llms: "/llms-start.txt",
    links: [
      { href: "/docs/getting-started", title: "Quick start", icon: "rocket" },
      { href: "/docs/recipes/first-workflow", title: "Your first shared operation", icon: "forms" },
      { href: "/docs/why-pracht", title: "Why pracht", icon: "sparkles" },
      { href: "/docs/demo-comparison", title: "Example app tour", icon: "presentation" },
      { href: "/docs/examples", title: "Examples", icon: "apps" },
      { href: "/docs/migrate/nextjs", title: "Migrate from Next.js", icon: "refresh" },
    ],
  },
  {
    label: "Core concepts",
    llms: "/llms-core.txt",
    links: [
      { href: "/docs/routing", title: "Routing", icon: "route" },
      { href: "/docs/pages-router", title: "Pages router", icon: "folders" },
      { href: "/docs/rendering", title: "Rendering modes", icon: "bolt" },
      { href: "/docs/data-loading", title: "Data loading", icon: "server" },
      { href: "/docs/head", title: "Head and headers", icon: "heading" },
      { href: "/docs/shells", title: "Shells", icon: "layout" },
      { href: "/docs/middleware", title: "Middleware", icon: "shield" },
      { href: "/docs/api-routes", title: "API routes", icon: "plug" },
      { href: "/docs/islands", title: "Islands", icon: "sparkles" },
      { href: "/docs/server-islands", title: "Server islands", icon: "user-bolt" },
    ],
  },
  {
    label: "Features",
    llms: "/llms-features.txt",
    links: [
      { href: "/docs/content", title: "Content collections", icon: "file-text" },
      { href: "/docs/api-validation", title: "API validation", icon: "test" },
      { href: "/docs/openapi", title: "OpenAPI", icon: "sitemap" },
      { href: "/docs/styling", title: "Styling", icon: "palette" },
      { href: "/docs/fonts", title: "Fonts", icon: "typography" },
      { href: "/docs/images", title: "Images", icon: "photo" },
      { href: "/docs/env", title: "Environment variables", icon: "key" },
      { href: "/docs/prefetching", title: "Prefetching", icon: "bolt" },
      { href: "/docs/performance", title: "Performance", icon: "gauge" },
    ],
  },
  {
    label: "Deploy",
    llms: "/llms-guides.txt",
    links: [
      { href: "/docs/deployment", title: "Deployment", icon: "cloud" },
      { href: "/docs/adapters", title: "Adapters", icon: "plug" },
      { href: "/docs/adapters/cloudflare", title: "Cloudflare Workers", icon: "brand-cloudflare" },
      { href: "/docs/adapters/node", title: "Node.js", icon: "brand-nodejs" },
      { href: "/docs/adapters/vercel-netlify", title: "Vercel and Netlify", icon: "triangle" },
      { href: "/docs/adapters/static", title: "Static export", icon: "file-export" },
    ],
  },
  {
    label: "Agents",
    llms: "/llms-agents.txt",
    links: [
      { href: "/docs/agents", title: "Overview", icon: "world-bolt" },
      { href: "/docs/capabilities", title: "Capabilities", icon: "robot" },
      { href: "/docs/mcp-tools", title: "WebMCP and remote MCP", icon: "webhook" },
      { href: "/docs/standalone-capabilities", title: "Standalone capabilities", icon: "plug" },
      { href: "/docs/agent-trust", title: "Agent trust", icon: "shield-check" },
      { href: "/docs/agent-audit", title: "Audit trail", icon: "history" },
      { href: "/docs/agent-eval", title: "Testing agent flows", icon: "checklist" },
      { href: "/docs/coding-agents", title: "Coding agents", icon: "terminal" },
    ],
  },
  {
    label: "Recipes",
    llms: "/llms-recipes.txt",
    links: [
      { href: "/docs/recipes/auth", title: "Authentication", icon: "lock" },
      { href: "/docs/recipes/forms", title: "Forms", icon: "forms" },
      { href: "/docs/recipes/i18n", title: "Internationalization", icon: "world" },
      { href: "/docs/recipes/csp", title: "Content Security Policy", icon: "shield" },
      { href: "/docs/recipes/testing", title: "Testing", icon: "test" },
      { href: "/docs/recipes/logging", title: "Logging", icon: "activity" },
      { href: "/docs/recipes/streaming", title: "SSE and WebSockets", icon: "broadcast" },
      { href: "/docs/recipes/tanstack-query", title: "TanStack Query", icon: "server" },
      { href: "/docs/recipes/view-transitions", title: "View transitions", icon: "sparkles" },
      { href: "/docs/recipes/fullstack-cloudflare", title: "Full-stack Cloudflare", icon: "cloud" },
      { href: "/docs/recipes/fullstack-vercel", title: "Full-stack Vercel", icon: "triangle" },
    ],
  },
  {
    label: "Reference",
    llms: "/llms-reference.txt",
    links: [
      { href: "/docs/reference/api", title: "API", icon: "book" },
      { href: "/docs/reference/hooks", title: "Client hooks", icon: "code" },
      { href: "/docs/cli", title: "CLI", icon: "terminal" },
      { href: "/docs/reference/config", title: "Configuration", icon: "adjustments" },
      { href: "/docs/reference/i18n", title: "i18n", icon: "language" },
    ],
  },
];

/** The anchor of a section on the docs home page (`/docs#core-concepts`). */
export function sectionId(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-");
}

/**
 * A Markdown table of contents: an H1, an introduction, one H2 per section
 * linking each page's `.md` source, and the agent tools. Served as `/index.md`
 * and `/docs.md`.
 */
export function navMarkdown(title: string, intro: string): string {
  return [
    `# ${title}`,
    "",
    intro,
    "",
    "Each link is the Markdown version of a docs page. A page URL without `.md` answers the same Markdown to requests sent with `Accept: text/markdown`. https://pracht.resynapse.dev/llms.txt indexes the same pages with one-line summaries.",
    "",
    ...NAV.flatMap((section) => [
      `## ${section.label}`,
      "",
      ...section.links.map((link) => `- [${link.title}](${link.href}.md)`),
      "",
    ]),
    "## Tools",
    "",
    "- Docs MCP server (Streamable HTTP): `https://pracht.resynapse.dev/mcp` with `docs_search`, `docs_read`, and `docs_list`.",
    "- Agent skills: `https://pracht.resynapse.dev/.well-known/agent-skills/index.json`.",
    "",
  ].join("\n");
}

export interface NavEntry extends NavLink {
  section: string;
}

/** Every page in sidebar order, each tagged with its section label. */
export const NAV_PAGES: readonly NavEntry[] = NAV.flatMap((section) =>
  section.links.map((link) => ({ ...link, section: section.label })),
);

/** The sidebar entry for a docs path, with its neighbours in reading order. */
export function navContext(path: string): {
  entry: NavEntry | undefined;
  prev: NavEntry | undefined;
  next: NavEntry | undefined;
} {
  const index = NAV_PAGES.findIndex((page) => page.href === path);
  if (index === -1) return { entry: undefined, prev: undefined, next: undefined };
  return { entry: NAV_PAGES[index], prev: NAV_PAGES[index - 1], next: NAV_PAGES[index + 1] };
}
