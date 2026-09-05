import { defer, Suspense, use, useIsHydrated } from "@pracht/core";
import type { Deferred, RouteComponentProps } from "@pracht/core";
import { useState } from "preact/hooks";

export const RENDER_MODE = "ssr";
export const STREAMING = true;

export function loader() {
  return {
    message: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("Deferred content"), 150)),
    ),
  };
}

function Empty({ value }: { value: Deferred<string> }) {
  use(value);
  return null;
}

function Content({ value }: { value: Deferred<string> }) {
  const message = use(value);
  const hydrated = useIsHydrated();
  const [count, setCount] = useState(0);
  return (
    <>
      <p id="streamed-message">{message}</p>
      <button disabled={!hydrated} id="streamed-counter" onClick={() => setCount(count + 1)}>
        Count {count}
      </button>
    </>
  );
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Streaming SSR</h1>
      <Suspense fallback={<p>Loading empty boundary</p>}>
        <Empty value={data.message} />
      </Suspense>
      <Suspense fallback={<p>Loading content</p>}>
        <Content value={data.message} />
      </Suspense>
    </section>
  );
}
