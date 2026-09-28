import { Link, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

/**
 * Loader data is not limited to JSON: Dates, Maps, Sets, BigInts, and shared
 * references arrive in the browser as the same types the loader returned,
 * on the first load and after client navigation alike.
 */
export async function loader({ url }: LoaderArgs) {
  const owner = { name: "Ada" };
  return {
    visit: Number(url.searchParams.get("visit") ?? "1"),
    publishedAt: new Date("2026-01-15T12:00:00.000Z"),
    stock: new Map([
      ["widgets", 3],
      ["gears", 0],
    ]),
    tags: new Set(["new", "sale"]),
    views: 9007199254740993n,
    owner,
    lastEditor: owner,
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Rich loader data</h1>
      <p data-testid="rich-visit">Visit {data.visit}</p>
      <p data-testid="rich-published">{data.publishedAt.toISOString()}</p>
      <p data-testid="rich-stock">{data.stock.get("widgets")} widgets in stock</p>
      <p data-testid="rich-tags">{[...data.tags].join(", ")}</p>
      <p data-testid="rich-views">{data.views.toString()} views</p>
      <p>
        <Link route="rich-data" search={{ visit: String(data.visit + 1) }} data-testid="rich-next">
          Load again with client navigation
        </Link>
      </p>
    </section>
  );
}

export function head() {
  return { title: "Rich loader data" };
}
