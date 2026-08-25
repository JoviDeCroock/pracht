import { Component, Fragment, h } from "preact";
import type { ComponentChildren, VNode } from "preact";

/**
 * Props of the standalone `<ErrorBoundary>` component.
 *
 * Distinct from {@link ErrorBoundaryProps} in `types.ts`, which describes the
 * `{ error }` props the runtime passes to a route's or shell's exported
 * `ErrorBoundary`. That export handles the whole route; this component handles
 * a subtree the app chooses.
 */
export interface ErrorBoundaryComponentProps {
  children?: ComponentChildren;
  /**
   * Rendered in place of the children once an error is caught. A function
   * receives the error and a `retry` callback that clears the captured error
   * and re-renders the children.
   */
  fallback?: ComponentChildren | ((error: Error, retry: () => void) => ComponentChildren);
  /** Called with every caught error, before the fallback renders. */
  onError?: (error: Error) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catch render errors in a subtree without taking down the page.
 *
 * A route or shell that wants to handle *its own* failures exports
 * `ErrorBoundary` instead; the runtime renders it with the route error. This
 * component is for the smaller case — an embedded widget, a lazy island, a
 * third-party integration — where only part of a working page should be
 * replaced.
 *
 * ```jsx
 * <ErrorBoundary fallback={(error, retry) => <Failed error={error} onRetry={retry} />}>
 *   <Editor />
 * </ErrorBoundary>
 * ```
 *
 * Promises thrown for suspension pass straight through: this boundary declines
 * them so `<Suspense>` still sees them. Without a `<Suspense>` ancestor the
 * promise keeps propagating, exactly as it would without this boundary.
 */
export class ErrorBoundary extends Component<ErrorBoundaryComponentProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  componentDidCatch(error: unknown): void {
    // Preact treats a component as a boundary only when the handler marks it
    // dirty. Rethrowing lets both the client walker and the async server
    // renderer continue handling suspensions without treating them as errors.
    if (isThenable(error)) throw error;
    const normalizedError = normalizeCaughtError(error);
    this.props.onError?.(normalizedError);
    this.setState({ error: normalizedError });
  }

  render(props: ErrorBoundaryComponentProps, state: ErrorBoundaryState): VNode {
    if (state.error === null) return h(Fragment, null, props.children);
    const { fallback } = props;
    return h(
      Fragment,
      null,
      typeof fallback === "function"
        ? (fallback as (error: Error, retry: () => void) => ComponentChildren)(
            state.error,
            this.retry,
          )
        : fallback,
    );
  }

  private retry = (): void => {
    this.setState({ error: null });
  };
}

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

function normalizeCaughtError(value: unknown): Error {
  if (value instanceof Error) return value;
  try {
    return new Error(String(value));
  } catch {
    return new Error("Unknown error");
  }
}
