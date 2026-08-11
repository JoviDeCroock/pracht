import { useLocation } from "@pracht/core";

/**
 * Written to `dist/client/404.html`. Static hosts serve it for every unmatched
 * URL without rewriting the address bar, so the path is read from the browser
 * rather than baked into the document.
 */
export function Component() {
  const location = useLocation();

  return (
    <section>
      <h1 data-testid="not-found">404 — page not found</h1>
      <p>
        No page lives at <code data-testid="requested-path">{location.pathname}</code>.
      </p>
      <a href="/">Back home</a>
    </section>
  );
}
