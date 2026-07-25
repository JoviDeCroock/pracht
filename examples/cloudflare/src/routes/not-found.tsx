import { useLocation } from "@pracht/core";

export function Component() {
  const location = useLocation();

  return (
    <section id="not-found">
      <h1>404 — page not found</h1>
      <p>
        No page lives at <code id="requested-path">{location.pathname}</code>.
      </p>
      <a href="/">Back home</a>
    </section>
  );
}
