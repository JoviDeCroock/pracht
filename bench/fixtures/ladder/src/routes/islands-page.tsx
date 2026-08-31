import CounterIsland from "../islands/counter.tsx";

// Rung 2: hydration "islands". Only the island chunk and the islands bootstrap
// reach the browser; the router runtime never loads.
export function Component() {
  return (
    <section>
      <h1>Bundle ladder</h1>
      <p>Every rung renders this paragraph.</p>
      <CounterIsland start={0} />
    </section>
  );
}
