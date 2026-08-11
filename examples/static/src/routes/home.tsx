import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { listDocs } from "../content.ts";

export async function loader(_args: LoaderArgs) {
  return {
    builtAt: new Date(0).toISOString(),
    docs: listDocs().map((doc) => ({ slug: doc.slug, title: doc.title })),
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Static output</h1>
      <p data-testid="built-at">Loader ran at build time: {data.builtAt}</p>
      <ul>
        {data.docs.map((doc) => (
          <li key={doc.slug}>
            <a href={`/docs/${doc.slug}`}>{doc.title}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
