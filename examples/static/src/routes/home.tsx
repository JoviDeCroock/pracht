import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {
    tagline: "Every page is a file.",
    // A loader returning user-ish HTML must stay inert in the serialized
    // state file exactly as it does in the live route-state endpoint — the
    // e2e suite asserts this string is never interpreted as markup.
    unsafe: '<script>window.__pwned = true;</script><img src=x onerror="window.__pwned=true">',
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section id="home">
      <h1>Static pracht</h1>
      <p id="tagline">{data.tagline}</p>
      <p id="unsafe">{data.unsafe}</p>
    </section>
  );
}
