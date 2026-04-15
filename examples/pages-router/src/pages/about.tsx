import { useLocation } from "@pracht/core";

export const RENDER_MODE = "ssg";

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
