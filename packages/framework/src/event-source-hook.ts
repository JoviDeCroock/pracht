import { useEffect, useState } from "preact/hooks";

export type EventSourceStatus = "connecting" | "open" | "closed";

export interface UseEventSourceOptions {
  /**
   * Named SSE event to listen for (the server's `event:` field). Defaults to
   * unnamed messages (`"message"`).
   */
  event?: string;
  /** `JSON.parse` incoming data. Malformed payloads are dropped with a warning. */
  json?: boolean;
  /** Send cookies on cross-origin connections (the `EventSource` option). */
  withCredentials?: boolean;
}

export interface EventSourceState<T> {
  /** The most recent message payload, or `undefined` before the first one. */
  data: T | undefined;
  /**
   * `"connecting"` while the browser establishes (or re-establishes — the
   * browser reconnects automatically) the connection, `"open"` while it is
   * live, `"closed"` when it gave up, was disabled with a `null` URL, or is
   * rendering on the server.
   */
  status: EventSourceStatus;
  /** The `lastEventId` of the most recent message (the server's `id:` field). */
  lastEventId: string | undefined;
}

interface EventSourceSubscription {
  href: string | null;
  event: string;
  json: boolean;
  withCredentials: boolean;
}

interface InternalEventSourceState<T> {
  state: EventSourceState<T>;
  subscription: EventSourceSubscription;
}

function sameSubscription(left: EventSourceSubscription, right: EventSourceSubscription): boolean {
  return (
    left.href === right.href &&
    left.event === right.event &&
    left.json === right.json &&
    left.withCredentials === right.withCredentials
  );
}

function emptyState<T>(status: EventSourceStatus): EventSourceState<T> {
  return { data: undefined, lastEventId: undefined, status };
}

/** `EventSource.CLOSED` — inlined so mocks without the constant still work. */
const CLOSED_READY_STATE = 2;

/**
 * Subscribe to a Server-Sent Events endpoint (see `createEventStream` on the
 * server side). The connection opens on mount and closes automatically on
 * unmount or when `url`/options change; a changed subscription starts clean
 * (`data`/`lastEventId` reset) so one endpoint's payload is never shown as
 * another's. Each hook instance opens its own connection — remember browsers
 * cap concurrent HTTP/1.1 connections per origin (6 in practice), so share
 * one subscription via context/props rather than mounting many for one URL.
 * Pass `null` to stay disconnected —
 * useful to gate the subscription on user state. During SSR it renders as
 * `{ status: "connecting" }` (or `"closed"` for a `null` URL) and never
 * connects.
 *
 * ```tsx
 * const { data, status } = useEventSource<{ now: number }>("/api/live", { json: true });
 * ```
 */
export function useEventSource<T = string>(
  url: string | URL | null | undefined,
  options: UseEventSourceOptions = {},
): EventSourceState<T> {
  const { event = "message", json = false, withCredentials = false } = options;
  const href = url == null ? null : String(url);
  const subscription: EventSourceSubscription = { event, href, json, withCredentials };

  const [current, setCurrent] = useState<InternalEventSourceState<T>>({
    state: emptyState(href == null ? "closed" : "connecting"),
    subscription,
  });

  // Effects run after render. If the subscription changed, returning
  // `current.state` here would paint the previous endpoint's payload for one
  // frame before the cleanup/reset below runs. Derive the clean public state
  // synchronously while the effect catches the internal state up.
  const state = sameSubscription(current.subscription, subscription)
    ? current.state
    : emptyState<T>(href == null ? "closed" : "connecting");

  useEffect(() => {
    if (href == null || typeof EventSource === "undefined") {
      setCurrent((previous) =>
        sameSubscription(previous.subscription, subscription) &&
        previous.state.status === "closed" &&
        previous.state.data === undefined &&
        previous.state.lastEventId === undefined
          ? previous
          : { state: emptyState("closed"), subscription },
      );
      return;
    }

    // A new subscription starts from a clean slate: carrying the previous
    // endpoint's `data`/`lastEventId` into a different `url` (or a different
    // named event) would present another stream's payload as this one's. On
    // first mount this is a no-op — the initial state already looks like this.
    setCurrent((previous) =>
      sameSubscription(previous.subscription, subscription) &&
      previous.state.status === "connecting" &&
      previous.state.data === undefined &&
      previous.state.lastEventId === undefined
        ? previous
        : { state: emptyState("connecting"), subscription },
    );
    const source = new EventSource(href, { withCredentials });

    const onOpen = (): void => {
      setCurrent((previous) =>
        sameSubscription(previous.subscription, subscription)
          ? { ...previous, state: { ...previous.state, status: "open" } }
          : previous,
      );
    };
    // EventSource reconnects on its own; `error` only means "gone for good"
    // once the readyState reaches CLOSED.
    const onError = (): void => {
      const status: EventSourceStatus =
        source.readyState === CLOSED_READY_STATE ? "closed" : "connecting";
      setCurrent((previous) => {
        if (!sameSubscription(previous.subscription, subscription)) return previous;
        return previous.state.status === status
          ? previous
          : { ...previous, state: { ...previous.state, status } };
      });
    };
    const onMessage = (messageEvent: MessageEvent): void => {
      let data: T;
      if (json) {
        try {
          data = JSON.parse(messageEvent.data as string) as T;
        } catch {
          console.warn(`[pracht] useEventSource(${href}): dropped non-JSON message`);
          return;
        }
      } else {
        data = messageEvent.data as T;
      }
      setCurrent((previous) =>
        sameSubscription(previous.subscription, subscription)
          ? {
              ...previous,
              state: {
                ...previous.state,
                data,
                lastEventId: messageEvent.lastEventId || undefined,
              },
            }
          : previous,
      );
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener(event, onMessage as EventListener);

    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.removeEventListener(event, onMessage as EventListener);
      source.close();
    };
  }, [href, event, json, withCredentials]);

  return state;
}
