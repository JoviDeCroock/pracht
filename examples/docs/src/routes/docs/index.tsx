import { NAV, navMarkdown, sectionId } from "../../nav";
import { SITE_NAME, absoluteUrl } from "../../site";

const START = [
  {
    href: "/docs/getting-started",
    title: "Quick start",
    body: "Create an app, run it, and deploy it.",
  },
  {
    href: "/docs/routing",
    title: "Routing",
    body: "Declare routes, shells, and render modes in one manifest.",
  },
  {
    href: "/docs/capabilities",
    title: "Capabilities",
    body: "Expose typed operations to your UI and to agents.",
  },
  {
    href: "/docs/coding-agents",
    title: "Coding agents",
    body: "Connect these docs and your app graph to an agent.",
  },
];

/** `/docs.md`: the same table of contents as `/index.md`. */
export const markdown = navMarkdown(
  "pracht documentation",
  "Guides and reference for pracht, a full-stack Preact framework on Vite.",
);

/** The docs home: start points, then every section of the sidebar. */
export function Component() {
  return (
    <div class="doc-page docs-home">
      <article class="doc-article">
        <h1 class="doc-title">{SITE_NAME} documentation</h1>
        <p class="doc-lead">
          pracht is a full-stack Preact framework on Vite. Each route picks its rendering mode, and
          typed capabilities serve your UI and agents from one definition.
        </p>
        <ul class="docs-home-start">
          {START.map((item) => (
            <li key={item.href}>
              <a href={item.href}>
                <strong>{item.title}</strong>
                <span>{item.body}</span>
              </a>
            </li>
          ))}
        </ul>
        {NAV.map((section) => (
          <section key={section.label} class="docs-home-section">
            <h2 id={sectionId(section.label)}>{section.label}</h2>
            <ul>
              {section.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href}>{link.title}</a>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section class="docs-home-section">
          <h2 id="for-agents">For agents</h2>
          <ul>
            <li>
              <a href="/llms.txt">llms.txt</a>
            </li>
            <li>
              <a href="/llms-full.txt">llms-full.txt</a>
            </li>
            <li>
              <a href="/docs/coding-agents#the-docs-mcp-server">Docs MCP server</a>
            </li>
            <li>
              <a href="/.well-known/agent-skills/index.json">Agent skills index</a>
            </li>
          </ul>
        </section>
      </article>
    </div>
  );
}

export function head() {
  const description =
    "Guides and reference for pracht: routing, rendering modes, data loading, capabilities for agents, deployment adapters, and recipes.";
  return {
    title: `Documentation — ${SITE_NAME}`,
    meta: [
      { name: "description", content: description },
      { property: "og:title", content: `Documentation — ${SITE_NAME}` },
      { property: "og:description", content: description },
      { property: "og:url", content: absoluteUrl("/docs") },
      { name: "twitter:title", content: `Documentation — ${SITE_NAME}` },
      { name: "twitter:description", content: description },
    ],
    link: [{ rel: "canonical", href: absoluteUrl("/docs") }],
  };
}
