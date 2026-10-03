import Disclosure from "../islands/Disclosure.tsx";
import Visitor from "../server-islands/Visitor.tsx";

// Server islands passed into an island as children. The open disclosure places
// its children on the server; the closed one ships them unplaced, so their
// server island is fetched only once the disclosure is first opened.
export function Component() {
  return (
    <section>
      <h1>Server islands in island children</h1>
      <Disclosure summary="Open by default" open>
        <Visitor greeting="Shown" fallback={<p data-testid="shown-visitor">Loading visitor…</p>} />
      </Disclosure>
      <Disclosure summary="Closed by default">
        <Visitor
          greeting="Revealed"
          fallback={<p data-testid="revealed-visitor">Loading visitor…</p>}
        />
      </Disclosure>
    </section>
  );
}
