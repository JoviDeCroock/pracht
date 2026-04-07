import type { LoaderArgs, RouteComponentProps } from "previte";

export async function loader(_args: LoaderArgs) {
  return {
    highlights: ["Hybrid route manifest", "Per-route rendering modes", "Thin deployment adapters"],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Previte starts with an explicit app manifest.</h1>
      <ul>
        {data.highlights.map((highlight) => (
          <li key={highlight}>{highlight}</li>
        ))}
      </ul>
    </section>
  );
}
