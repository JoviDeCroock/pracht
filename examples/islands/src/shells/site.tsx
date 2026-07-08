import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="site-shell">
      <header>
        <strong>Pracht Islands</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/lazy">Lazy</a>
          <a href="/static">Static</a>
          <a href="/ssr">SSR</a>
          <a href="/full">Full</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>Mostly static. Islands of interactivity.</footer>
    </div>
  );
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht Islands Example",
  };
}
