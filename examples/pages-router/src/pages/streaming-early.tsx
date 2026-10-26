import { defer, Suspense, use, useIsHydrated } from "@pracht/core";
import type { Deferred, LoaderArgs, RouteComponentProps } from "@pracht/core";
import { useState } from "preact/hooks";

import { streamLatch } from "../stream-latch.ts";

export const RENDER_MODE = "ssr";
export const STREAMING = true;

export function loader({ url }: LoaderArgs) {
  return {
    fast: defer(Promise.resolve("Fast content")),
    slow: defer(streamLatch(url.searchParams.get("token") ?? "").promise),
  };
}

function Counter({ id }: { id: string }) {
  const [count, setCount] = useState(0);
  return (
    <button id={id} onClick={() => setCount(count + 1)}>
      Count {count}
    </button>
  );
}

function Message({ id, value }: { id: string; value: Deferred<string> }) {
  const message = use(value);
  const hydrated = useIsHydrated();
  return (
    <div>
      <p id={id}>{message}</p>
      <span id={`${id}-hydrated`}>{hydrated ? "hydrated" : "server"}</span>
      <Counter id={`${id}-counter`} />
    </div>
  );
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section>
      <h1>Early hydration</h1>
      <Counter id="shell-counter" />
      <Suspense fallback={<p id="fast-fallback">Loading fast</p>}>
        <Message id="fast" value={data.fast} />
      </Suspense>
      <Suspense fallback={<p id="slow-fallback">Loading slow</p>}>
        <Message id="slow" value={data.slow} />
      </Suspense>
    </section>
  );
}
