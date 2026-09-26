import Visitor from "../regions/Visitor.tsx";

// A cached islands page whose region brings an island along: the island
// hydrates once the region's HTML has been swapped in.
export function Component() {
  return (
    <section>
      <h1>Regions with islands</h1>
      <Visitor
        greeting="Hello"
        withCounter
        fallback={<p data-testid="visitor">Loading visitor…</p>}
      />
    </section>
  );
}
