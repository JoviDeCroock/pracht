import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

// Served when a client requests `Accept: text/markdown` (Markdown-for-Agents);
// llms.txt flags this route as markdown-capable.
export const markdown = `# Pracht Example

Pracht starts with an explicit app manifest.

- Hybrid route manifest
- Per-route rendering modes
- Thin deployment adapters
`;

export async function loader(_args: LoaderArgs) {
  return {
    highlights: ["Hybrid route manifest", "Per-route rendering modes", "Thin deployment adapters"],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Pracht starts with an explicit app manifest.</h1>
      <ul>
        {data.highlights.map((highlight) => (
          <li key={highlight}>{highlight}</li>
        ))}
      </ul>
    </section>
  );
}
