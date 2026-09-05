import { Counter } from "../counter.tsx";

// Rung 3: hydration "full" (the default). The whole page hydrates and the
// client router takes over navigation.
export function Component() {
  return (
    <section>
      <h1>Bundle ladder</h1>
      <p>Every rung renders this paragraph.</p>
      <Counter start={0} />
    </section>
  );
}
