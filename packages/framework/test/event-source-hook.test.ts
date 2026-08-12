// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEventSource, type EventSourceState } from "../src/event-source-hook.ts";

/**
 * jsdom ships no EventSource; a scripted stand-in records instances and lets
 * tests dispatch protocol events by hand.
 */
class MockEventSource {
  static instances: MockEventSource[] = [];

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  withCredentials: boolean;
  readyState = MockEventSource.CONNECTING;
  closed = false;

  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  emitOpen(): void {
    this.readyState = MockEventSource.OPEN;
    this.dispatch("open", new Event("open"));
  }

  emitError(options: { terminal?: boolean } = {}): void {
    this.readyState = options.terminal ? MockEventSource.CLOSED : MockEventSource.CONNECTING;
    this.dispatch("error", new Event("error"));
  }

  emitMessage(type: string, data: string, lastEventId = ""): void {
    if (this.closed) throw new Error("emitMessage on a closed source");
    this.dispatch(type, new MessageEvent(type, { data, lastEventId }));
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Flush microtasks, requestAnimationFrame, and Preact effects/re-renders. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await Promise.resolve();
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("useEventSource", () => {
  let root: HTMLDivElement;
  let latest: EventSourceState<unknown> | undefined;

  async function renderHook(
    url: string | null,
    options?: Parameters<typeof useEventSource>[1],
  ): Promise<(nextUrl: string | null) => Promise<void>> {
    function Probe(props: { url: string | null }) {
      latest = useEventSource(props.url, options);
      return null;
    }
    const rerender = async (nextUrl: string | null) => {
      render(h(Probe, { url: nextUrl }), root);
      await flush();
    };
    await rerender(url);
    return rerender;
  }

  function source(index = 0): MockEventSource {
    const instance = MockEventSource.instances[index];
    if (!instance) throw new Error(`no MockEventSource instance ${index}`);
    return instance;
  }

  beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
    MockEventSource.instances = [];
    root = document.createElement("div");
    document.body.appendChild(root);
    latest = undefined;
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
  });

  it("connects on mount and tracks open status", async () => {
    await renderHook("/api/live");

    expect(MockEventSource.instances).toHaveLength(1);
    expect(source().url).toBe("/api/live");
    expect(latest).toMatchObject({ data: undefined, status: "connecting" });

    source().emitOpen();
    await flush();
    expect(latest).toMatchObject({ status: "open" });
  });

  it("delivers unnamed messages as raw strings by default", async () => {
    await renderHook("/api/live");
    source().emitMessage("message", "hello", "42");

    await flush();
    expect(latest).toMatchObject({ data: "hello", lastEventId: "42" });
  });

  it("parses JSON payloads with json: true and drops malformed ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderHook("/api/live", { json: true });

    source().emitMessage("message", '{"n":1}');
    await flush();
    expect(latest).toMatchObject({ data: { n: 1 } });

    source().emitMessage("message", "not json");
    await flush();
    // Previous data survives a malformed frame.
    expect(latest).toMatchObject({ data: { n: 1 } });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("listens only to the configured named event", async () => {
    await renderHook("/api/live", { event: "tick" });

    source().emitMessage("message", "ignored");
    await flush();
    expect(latest).toMatchObject({ data: undefined });

    source().emitMessage("tick", "taken");
    await flush();
    expect(latest).toMatchObject({ data: "taken" });
  });

  it("passes withCredentials through", async () => {
    await renderHook("/api/live", { withCredentials: true });
    expect(source().withCredentials).toBe(true);
  });

  it("reports reconnecting errors as connecting and terminal errors as closed", async () => {
    await renderHook("/api/live");
    source().emitOpen();
    await flush();

    // The 404/network-failure shape: the browser retries, then gives up.
    source().emitError();
    await flush();
    expect(latest).toMatchObject({ status: "connecting" });

    source().emitError({ terminal: true });
    await flush();
    expect(latest).toMatchObject({ status: "closed" });
  });

  it("stays closed with a null url and opens nothing", async () => {
    await renderHook(null);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(latest).toMatchObject({ status: "closed" });
  });

  it("closes the connection on unmount", async () => {
    await renderHook("/api/live");
    render(null, root);
    await flush();

    expect(source().closed).toBe(true);
  });

  it("swaps connections when the url changes and closes the old one first", async () => {
    const rerender = await renderHook("/api/a");
    await rerender("/api/b");

    expect(MockEventSource.instances).toHaveLength(2);
    expect(source(0).closed).toBe(true);
    expect(source(1).url).toBe("/api/b");
    expect(source(1).closed).toBe(false);
  });

  it("disconnects when the url becomes null", async () => {
    const rerender = await renderHook("/api/live");
    await rerender(null);

    expect(source().closed).toBe(true);
    expect(latest).toMatchObject({ status: "closed" });
  });

  it("survives an unmount race before the connection ever opens", async () => {
    await renderHook("/api/live");
    // Unmount immediately — no open, no message ever arrived. The only
    // observable requirement: the source is closed and a straggler event
    // dispatched by a sloppy mock afterwards does not throw.
    render(null, root);
    await flush();
    expect(source().closed).toBe(true);
    expect(() => source().emitOpen()).not.toThrow();
  });
});
