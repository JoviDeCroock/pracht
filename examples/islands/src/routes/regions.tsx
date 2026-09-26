import Visitor from "../regions/Visitor.tsx";

// Shared by the SSG and SSR region routes: the region is rendered inline on
// SSR and filled after load on the prerendered page.
export function Component() {
  return (
    <section>
      <h1>Request-time regions</h1>
      <p>The rest of this page is the same for every visitor.</p>
      <Visitor greeting="Welcome back" fallback={<p data-testid="visitor">Loading visitor…</p>} />
    </section>
  );
}
