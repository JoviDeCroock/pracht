import type { RouteParams } from "@pracht/core";

export async function loader() {
  // Dynamic SPA routes are not enumerated at build time, so this loader
  // payload has no static file to live in. On a static host the client
  // renders with `data` undefined — real data belongs in a client-side fetch.
  return { note: "build-time only" };
}

export function Component({ data, params }: { data?: { note: string }; params: RouteParams }) {
  return (
    <section id="item">
      <h1>Item {params.id}</h1>
      <p id="item-note">{data ? data.note : "no build-time data"}</p>
      <a href="/dashboard">Back to dashboard</a>
    </section>
  );
}
