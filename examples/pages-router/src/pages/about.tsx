import { useLocation } from "@pracht/core";

export const RENDER_MODE = "ssg";

// Served when a client requests `Accept: text/markdown` (Markdown-for-Agents);
// llms.txt flags this route as markdown-capable.
export const markdown = `# About

A static page rendered with SSG via the pages router.
`;

export function Component() {
  const { pathname, search } = useLocation();

  return (
    <section>
      <h1>About</h1>
      <p>A static page rendered with SSG via the pages router.</p>
      <p class="location-pathname">Pathname: {pathname}</p>
      <p class="location-search">Search: {search || "(empty)"}</p>
    </section>
  );
}
