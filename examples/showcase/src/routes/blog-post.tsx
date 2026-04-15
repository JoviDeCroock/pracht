import type { LoaderArgs, RouteComponentProps, RouteParams } from "@pracht/core";

interface Post {
  title: string;
  date: string;
  body: string;
}

const POSTS: Record<string, Post> = {
  "why-pracht": {
    title: "Why we built Pracht",
    date: "2026-04-10",
    body: `Most frameworks force you to pick one rendering strategy for your entire app.
SSG for the marketing site? Great — but now your dashboard is also static.
SSR everywhere? Your blog posts pay the cost of server rendering on every request.

Pracht lets each route declare its own render mode. Marketing pages are pre-built
at deploy time. Pricing revalidates hourly. The dashboard renders fresh on every
request. Settings loads entirely in the browser.

One manifest. One build. Four modes. Each route gets exactly what it needs.`,
  },
  "per-route-rendering": {
    title: "Per-route rendering explained",
    date: "2026-04-12",
    body: `In your routes.ts manifest, every route() call accepts a render option:
"ssg", "ssr", "isg", or "spa". Groups inherit defaults — you can set
render: "ssg" on a group and override individual routes.

SSG routes run their loader at build time. SSR routes run it per-request.
ISG routes run it at build time, then revalidate on a timer. SPA routes
skip server rendering entirely and load the component in the browser.

After the first page load, client-side navigation takes over for all modes.
The static HTML only matters for the initial request and search engines.`,
  },
};

export function getStaticPaths(): RouteParams[] {
  return Object.keys(POSTS).map((slug) => ({ slug }));
}

export function loader({ params }: LoaderArgs) {
  const post = POSTS[params.slug];
  if (!post) throw new Error("Post not found");
  return post;
}

export function head({ data }: RouteComponentProps<typeof loader>) {
  return {
    title: `${data.title} — Launchpad Blog`,
    meta: [
      { property: "og:title", content: data.title },
      { property: "og:type", content: "article" },
      { name: "author", content: "Launchpad Team" },
    ],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <article class="blog-post">
      <header>
        <h1>{data.title}</h1>
        <time datetime={data.date}>{data.date}</time>
      </header>
      {data.body.split("\n\n").map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      <footer>
        <a href="/blog/why-pracht">Why we built Pracht</a>
        <span class="sep">&middot;</span>
        <a href="/blog/per-route-rendering">Per-route rendering explained</a>
      </footer>
    </article>
  );
}
