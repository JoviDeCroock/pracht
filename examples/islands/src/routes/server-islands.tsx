import Visitor from "../server-islands/Visitor.tsx";

export const serverIslands = [Visitor];

// Shared by the SSG and SSR server island routes: the server island is rendered inline on
// SSR and filled after load on the prerendered page.
export function Component() {
  return (
    <section>
      <h1>Server islands</h1>
      <p>The rest of this page is the same for every visitor.</p>
      <Visitor greeting="Welcome back" fallback={<p data-testid="visitor">Loading visitor…</p>} />
    </section>
  );
}
