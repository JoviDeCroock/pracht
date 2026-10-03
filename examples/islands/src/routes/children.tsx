import Counter from "../islands/Counter.tsx";
import Disclosure from "../islands/Disclosure.tsx";

function ServerNote({ text }: { text: string }) {
  return <p data-testid="server-note">{text}</p>;
}

export function Component() {
  return (
    <section>
      <h1>Island children</h1>
      <p>
        Each disclosure is an island; what it wraps is server-rendered content, including another
        island.
      </p>
      <Disclosure summary="Open by default" open>
        <ServerNote text="Rendered on the server, never shipped as JavaScript." />
        <Counter start={10} />
      </Disclosure>
      <Disclosure summary="Closed by default">
        <p data-testid="later-note">Rendered on the server and shown when you open it.</p>
      </Disclosure>
    </section>
  );
}
