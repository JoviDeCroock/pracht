import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

// Tall page with a skip link, used by e2e tests for in-page fragment
// navigation: scrolling to the target, moving focus to it, and restoring the
// previous position on back. Kept separate from /long so its layout can change
// without disturbing the scroll-restoration tests measured against that page.
//
// The loader matters. A fragment click fires popstate, which the router used to
// treat as a back/forward traversal; the scroll restoration that followed only
// overwrote the browser's jump once it ran *after* it. On a route with no
// loader the router gets there first and the browser's jump wins anyway, hiding
// the bug — the round trip a loader forces is what makes it observable.
export async function loader(_args: LoaderArgs) {
  return { message: "Fragment page loaded" };
}

export function head() {
  return { title: "Fragment page" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="fragment-page">
      <a href="#fragment-main" id="skip-link">
        Skip to content
      </a>
      <h1>Fragment page</h1>
      <p>{data.message}</p>
      <div style={{ height: "3000px" }}>Tall content</div>
      <main id="fragment-main">
        <h2>Main content</h2>
        <p>
          <a href="/" id="fragment-home-link">
            Back home
          </a>
        </p>
      </main>
      <div style={{ height: "3000px" }}>More tall content</div>
    </section>
  );
}
