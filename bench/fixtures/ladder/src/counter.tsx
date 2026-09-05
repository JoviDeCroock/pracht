import { useState } from "preact/hooks";

/**
 * The one interactive component in the fixture.
 *
 * Every rung renders the same markup, so this file is shared between the
 * island route and the full-hydration route: the measured delta between them
 * is framework runtime, not application code.
 */
export function Counter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      Count: {count}
    </button>
  );
}
