import { useState } from "preact/compat";

// Rung 4: the same full-hydration page as the ladder fixture, with the React
// compatibility layer in the client graph. The delta against the ladder's
// `/full` route is what `preact/compat` costs.
export function Component() {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h1>Bundle ladder</h1>
      <p>Every rung renders this paragraph.</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Count: {count}
      </button>
    </section>
  );
}
