import type { ShellProps } from "@pracht/core";
import ShellCounter from "../islands/ShellCounter.tsx";

export function Shell({ children }: ShellProps) {
  return (
    <div class="site-shell">
      <header>
        <strong>Pracht Islands Guide</strong>
        <nav>
          <a href="/guide">Guide</a>
          <a href="/guide/next">Next</a>
          <a href="/static">Static</a>
          <a href="/full">Full</a>
        </nav>
        <ShellCounter />
      </header>
      <main>{children}</main>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
  };
}
