/**
 * Render errors in a streamed document's shell.
 *
 * `preact-render-to-string` renders the children of a class error boundary
 * without its streaming state, so a `<Suspense>` under an `<ErrorBoundary>`
 * throws its promise to the top of the shell. And a shell that throws after
 * one boundary suspended errors the renderer's stream while that boundary is
 * still pending: when it settles, the renderer writes into the errored stream
 * from a promise nobody observes, and Node exits on the rejection.
 *
 * While the shell renders, which the renderer does synchronously, Pracht
 * catches render errors itself through Preact's catchError hook, which the
 * renderer calls for every component that throws. An `ErrorBoundary` renders
 * its children into a slot the hook can empty and its fallback after it; the
 * shell root is a slot too, so the renderer's stream always completes and a
 * shell error is reported to the caller instead.
 */

import { Fragment, h, options } from "preact";
import type { ComponentChildren, VNode } from "preact";

import { STREAMED_SHELL_BOUNDARY, type StreamedShellBoundary } from "./error-boundary.ts";

interface Slot {
  /** The shell root also catches promises thrown outside every `<Suspense>`. */
  root: boolean;
  caught: boolean;
  error?: unknown;
}

function CatchSlot(props: { slot: Slot; children?: ComponentChildren }) {
  return props.children as VNode;
}

function FallbackSlot(props: { slot: Slot; render: (error: unknown) => ComponentChildren }) {
  return (props.slot.caught ? props.render(props.slot.error) : null) as VNode | null;
}

const boundary: StreamedShellBoundary = (children, renderFallback) => {
  const slot: Slot = { root: false, caught: false };
  return h(
    Fragment,
    null,
    h(CatchSlot, { slot }, children),
    h(FallbackSlot, { slot, render: renderFallback }),
  );
};

let rendering = false;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const previous = (options as any).__e;
  (options as any).__e = (error: unknown, vnode: any, oldVNode: unknown, errorInfo: unknown) => {
    if (rendering) {
      const thenable = typeof (error as { then?: unknown } | null)?.then === "function";
      // Every vnode on the parent chain is still rendering, so the nearest
      // slot owns this error. Rethrowing unwinds to it; a slot's own catch
      // records the error, and the renderer then renders that slot as empty.
      for (let parent = vnode; parent; parent = parent.__) {
        if (parent.type !== CatchSlot) continue;
        const slot = parent.props.slot as Slot;
        // ErrorBoundary declines suspensions, as its componentDidCatch does.
        if (thenable && !slot.root) continue;
        if (parent !== vnode) throw error;
        slot.caught = true;
        slot.error = thenable
          ? new Error(
              "A component suspended outside a <Suspense> boundary. A streamed route " +
                "renders its shell synchronously; wrap the component in <Suspense>.",
            )
          : error;
        return;
      }
    }
    previous?.(error, vnode, oldVNode, errorInfo);
  };
}

/**
 * Run `render` on `tree` with shell error handling installed. Returns what
 * `render` returned, plus the error that failed the shell, if one did.
 */
export function renderStreamedShell<T>(
  tree: VNode,
  render: (tree: VNode) => T,
): { result: T; failed: boolean; error?: unknown } {
  install();
  const root: Slot = { root: true, caught: false };
  const globals = globalThis as { [STREAMED_SHELL_BOUNDARY]?: StreamedShellBoundary };
  rendering = true;
  globals[STREAMED_SHELL_BOUNDARY] = boundary;
  try {
    const result = render(h(CatchSlot, { slot: root }, tree) as VNode);
    return { result, failed: root.caught, error: root.error };
  } finally {
    rendering = false;
    delete globals[STREAMED_SHELL_BOUNDARY];
  }
}
