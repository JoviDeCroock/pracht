export type ContextMethod = (...args: unknown[]) => unknown;

export interface ContextOverlayTarget {
  materializedContextKeys: Set<PropertyKey>;
  target: object | ContextMethod;
}
