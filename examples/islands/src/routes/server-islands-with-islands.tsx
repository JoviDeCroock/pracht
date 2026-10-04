import Visitor from "../server-islands/Visitor.tsx";

export const serverIslands = [Visitor];

// A cached islands page whose server island brings an island along: the island
// hydrates once the server island's HTML has been swapped in.
export function Component() {
  return (
    <section>
      <h1>Server islands with islands</h1>
      <Visitor
        greeting="Hello"
        withCounter
        fallback={<p data-testid="visitor">Loading visitor…</p>}
      />
    </section>
  );
}
