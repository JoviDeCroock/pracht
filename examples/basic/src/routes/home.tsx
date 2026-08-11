import type { LoaderArgs, MarkdownArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {
    highlights: ["Hybrid route manifest", "Per-route rendering modes", "Thin deployment adapters"],
  };
}

// Served for `Accept: text/markdown` and at `/index.md`. The loader has already
// run, so the Markdown representation reuses the same content source as HTML.
export async function markdown({ data }: MarkdownArgs<typeof loader>) {
  return `# Pracht Example

Pracht starts with an explicit app manifest.

${data.highlights.map((highlight) => `- ${highlight}`).join("\n")}
`;
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
