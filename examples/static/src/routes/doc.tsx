import {
  notFound,
  type LoaderArgs,
  type RouteComponentProps,
  type RouteParams,
} from "@pracht/core";
import { getDoc, listDocs } from "../content.ts";

/** Enumerates the paths the build prerenders for this pattern. */
export function getStaticPaths(): RouteParams[] {
  return listDocs().map((doc) => ({ slug: doc.slug }));
}

export async function loader({ params }: LoaderArgs) {
  const doc = getDoc(params.slug);
  if (!doc) throw notFound();
  return { doc };
}

export function head({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  return { title: `${data.doc.title} — Pracht Static Example` };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <article>
      <h1 data-testid="doc-title">{data.doc.title}</h1>
      <p data-testid="doc-body">{data.doc.body}</p>
    </article>
  );
}
