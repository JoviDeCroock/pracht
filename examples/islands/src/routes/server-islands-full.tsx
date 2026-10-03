import { useState } from "preact/hooks";
import Visitor from "../server-islands/Visitor.tsx";

// A cached full-hydration page: the whole tree hydrates, and the server island is an
// opaque subtree the client fills in after hydration. Re-rendering the page
// (the button) must leave the server island's HTML alone.
export function Component() {
  const [clicks, setClicks] = useState(0);
  return (
    <section>
      <h1>Server islands with full hydration</h1>
      <button type="button" data-testid="rerender" onClick={() => setClicks((c) => c + 1)}>
        Re-rendered {clicks} times
      </button>
      <Visitor greeting="Welcome back" fallback={<p data-testid="visitor">Loading visitor…</p>} />
    </section>
  );
}
