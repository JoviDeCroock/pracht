/**
 * `useCapability()` — call state for user-triggered capability calls.
 *
 * Deliberately *not* a fetch-on-render hook. Pracht's data model is
 * server-owned: loaders run on the server, `useRouteData()` reads their result
 * out of the SSR payload, and a successful non-`read` capability call already
 * revalidates that data through the effect class. Fetching during render would
 * add a client-side waterfall and render nothing during SSR — for data a page
 * needs, `loader` + `invokeCapability()` is both simpler and faster.
 *
 * What that leaves uncovered is the *interaction*: a button click, a search
 * box, a picker. `<Form capability>` already handles the form case; everything
 * else meant hand-rolling pending/error/result state around `callCapability`.
 * This hook is that state, nothing more.
 *
 * The dispatch function is injected rather than imported so the implementation
 * can live here (typed, unit-testable) while the app-specific endpoint table
 * stays in the generated `virtual:pracht/capabilities` module. One dispatch
 * path means the settled event, effect-driven revalidation, and custom
 * `expose.http.path` values behave identically however a capability is called.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { CapabilityEnvelope, CapabilityErrorPayload } from "@pracht/capabilities";

interface CapabilityCallState<TOutput> {
  /** Data from the most recent successful call, until `reset()`. */
  data: TOutput | undefined;
  /** Error payload from the most recent failed call, until `reset()`. */
  error: CapabilityErrorPayload | undefined;
  /** Whether a call is in flight. */
  pending: boolean;
}

export interface CapabilityHookResult<
  TOutput,
  TArgs extends unknown[],
> extends CapabilityCallState<TOutput> {
  /**
   * Dispatch the capability. Resolves to the same envelope `callCapability()`
   * returns — a failed call settles the envelope rather than throwing, so
   * branch on `result.ok` when you need the outcome at the call site.
   */
  call: (...args: TArgs) => Promise<CapabilityEnvelope<TOutput>>;
  /** Clear `data`/`error`/`pending` and abandon any in-flight result. */
  reset: () => void;
}

const IDLE = { data: undefined, error: undefined, pending: false } as const;

/**
 * Build a `useCapability` hook bound to a dispatch function. The generated
 * `virtual:pracht/capabilities` module calls this with its `callCapability`;
 * applications import the resulting hook, not this factory.
 */
export function createUseCapability(
  dispatch: (name: string, ...args: unknown[]) => Promise<CapabilityEnvelope<unknown>>,
) {
  return function useCapability<TOutput = unknown, TArgs extends unknown[] = unknown[]>(
    name: string,
  ): CapabilityHookResult<TOutput, TArgs> {
    // State carries the capability it came from. A component that switches
    // capability (a picker, a tab) would otherwise keep rendering the previous
    // one's `data` under the new one's output type — and a call still in flight
    // when the switch happened would land on the new name. Deriving the visible
    // state from a name match handles both without a render-phase update.
    const [state, setState] = useState<CapabilityCallState<TOutput> & { name: string }>({
      ...IDLE,
      name,
    });
    const current = state.name === name ? state : { ...IDLE, name };
    // Only the newest call may write state. Without this, a slow first request
    // resolving after a fast second one would overwrite the newer result —
    // exactly what happens when a user types into a search box.
    const latestCallId = useRef(0);
    const mounted = useRef(true);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    const call = useCallback(
      async (...args: TArgs): Promise<CapabilityEnvelope<TOutput>> => {
        const callId = ++latestCallId.current;
        const isCurrent = () => mounted.current && callId === latestCallId.current;
        if (isCurrent()) {
          // Keep the previous data visible while refetching; clear the stale
          // error so a retry does not render as still-failing. A call made
          // right after a name change starts from idle, not the old state.
          setState((previous) => ({
            ...(previous.name === name ? previous : IDLE),
            error: undefined,
            name,
            pending: true,
          }));
        }

        let envelope: CapabilityEnvelope<TOutput>;
        try {
          envelope = (await dispatch(name, ...args)) as CapabilityEnvelope<TOutput>;
        } catch (error) {
          // `callCapability` folds network failures into an envelope, so this
          // is a programming error (a bad argument, a broken custom dispatch).
          // Clear `pending` before rethrowing, or the UI stays stuck.
          if (isCurrent()) setState((previous) => ({ ...previous, pending: false }));
          throw error;
        }

        if (isCurrent()) {
          setState(
            envelope.ok
              ? { data: envelope.data, error: undefined, name, pending: false }
              : { data: undefined, error: envelope.error, name, pending: false },
          );
        }
        return envelope;
      },
      [name],
    );

    const reset = useCallback(() => {
      // Bumping the id abandons in-flight calls: their results are no longer
      // "current", so a late response cannot repopulate what was just cleared.
      latestCallId.current += 1;
      setState({ ...IDLE, name });
    }, [name]);

    const { name: _stateName, ...visible } = current;
    return { ...visible, call, reset };
  };
}
