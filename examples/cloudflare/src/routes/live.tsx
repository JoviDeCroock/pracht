import { useEventSource } from "@pracht/core";

interface TickPayload {
  now: string;
  tick: number;
}

/**
 * Consumes the `/api/live` Server-Sent Events endpoint with the
 * `useEventSource` hook. The connection opens on mount and closes on
 * unmount — navigate away and the server's producer loop stops.
 */
export function Component() {
  const { data, status } = useEventSource<TickPayload>("/api/live", {
    event: "tick",
    json: true,
  });

  return (
    <section>
      <h1>Live events</h1>
      <p>
        This page subscribes to <code>/api/live</code>, a Server-Sent Events endpoint built with
        <code> createEventStream()</code>, via the <code>useEventSource()</code> hook.
      </p>
      <p>
        Connection: <strong data-testid="live-status">{status}</strong>
      </p>
      <p data-testid="live-tick">
        {data ? `tick ${data.tick} at ${data.now}` : "waiting for the first event"}
      </p>
    </section>
  );
}

export function head() {
  return { title: "Live events" };
}
