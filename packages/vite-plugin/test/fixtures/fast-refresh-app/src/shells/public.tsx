import type { ComponentChildren } from "preact";

export function Shell({ children }: { children?: ComponentChildren }) {
  return <div id="shell">{children}</div>;
}
