import { Link, useRouteData, useSearch } from "@pracht/core";
import type { ErrorBoundaryProps, HeadArgs, LoaderArgs, SearchArgs } from "@pracht/core";
import * as z from "zod";

const ITEMS = ["Anvil", "Bolt", "Clamp", "Drill", "Epoxy", "File", "Gauge", "Hammer", "Jig"];
const PAGE_SIZE = 3;

// The query string, validated. Values arrive as strings (or string arrays for
// repeated keys), so numbers are coerced; defaults keep `/catalog` valid with
// no query at all. `pracht typegen` registers the input type for
// `<Link search>` and the output type for `useSearch("catalog")`.
export const search = z.object({
  page: z.coerce.number().int().min(1).default(1),
  q: z.string().trim().optional(),
});

export function loader(args: LoaderArgs & SearchArgs<typeof search>) {
  const { page, q } = args.search;
  const matches = q ? ITEMS.filter((item) => item.toLowerCase().includes(q.toLowerCase())) : ITEMS;
  return {
    items: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    pages: Math.max(1, Math.ceil(matches.length / PAGE_SIZE)),
  };
}

export function head(args: HeadArgs<typeof loader> & SearchArgs<typeof search>) {
  return { title: `Catalog — page ${args.search.page}` };
}

export function Component() {
  // With the generated declaration in the program, `useRouteData("catalog")`
  // and `useSearch("catalog")` infer these; the workspace typecheck compiles
  // this file without it, so the example spells the types out.
  const data = useRouteData<typeof loader>();
  const { page, q } = useSearch<z.output<typeof search>>();

  return (
    <section>
      <h1>Catalog</h1>
      <p data-testid="catalog-search">
        page={page} ({typeof page}) q={q ?? "none"}
      </p>
      <ul data-testid="catalog-items">
        {data.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <nav>
        {page > 1 && (
          <Link route="catalog" search={{ page: page - 1, q }} data-testid="catalog-prev">
            Previous
          </Link>
        )}
        {page < data.pages && (
          <Link route="catalog" search={{ page: page + 1, q }} data-testid="catalog-next">
            Next
          </Link>
        )}
      </nav>
    </section>
  );
}

// A query the schema rejects renders here with status 400 and the issues.
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return (
    <section>
      <h1 data-testid="catalog-error">
        {error.status} {error.message}
      </h1>
      <ul>
        {error.issues?.map((issue) => (
          <li key={issue.path?.join(".")} data-testid="catalog-issue">
            {issue.path?.join(".")}: {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
