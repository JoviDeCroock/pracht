import { NAV } from "../nav";

/** The site's 404 page, rendered inside the docs shell. */
export function Component() {
  return (
    <div class="doc-page not-found">
      <article class="doc-article">
        <p class="not-found-code">404</p>
        <h1 class="doc-title">Page not found</h1>
        <p class="doc-lead">
          This URL has no page. Search with <kbd>/</kbd>, or start from one of these sections.
        </p>
        <ul class="not-found-links">
          {NAV.map((section) => (
            <li key={section.label}>
              <a href={section.links[0].href}>{section.label}</a>
              <span>{section.links.map((link) => link.title).join(", ")}</span>
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}

export function head() {
  return {
    title: "Page not found — pracht docs",
    meta: [{ name: "robots", content: "noindex" }],
  };
}
