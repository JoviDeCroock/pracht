import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="public-shell">
      <header>
        <strong>Pracht + TSRX</strong>
        <nav>
          <a href="/">Home (.tsrx)</a>
          <a href="/about">About (.tsx)</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>
        <code>.tsrx</code> routes powered by <code>@tsrx/vite-plugin-preact</code>.
      </footer>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht TSRX Example",
  };
}
