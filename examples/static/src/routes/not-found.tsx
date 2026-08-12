import { useLocation } from "@pracht/core";

export function loader() {
  return { message: "Built custom 404" };
}

export function Component({ data }: { data: { message: string } }) {
  const location = useLocation();

  return (
    <section id="not-found">
      <h1>404 — page not found</h1>
      <p>
        Nothing lives at <code id="requested-path">{location.pathname}</code>.
      </p>
      <p id="not-found-data">{data.message}</p>
      <a href="/">Back home</a>
    </section>
  );
}
