import type { ShellProps } from "@pracht/core";
import "../styles.css";

export function Shell({ children }: ShellProps) {
  return (
    <div class="site">
      <header>
        <strong>Pracht Static</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/docs/routing">Docs</a>
          <a href="/about">About</a>
          <a href="/counter">Counter</a>
          <a href="/dashboard">Dashboard</a>
          <a href="/projects/42">Project 42</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>No server. Just files.</footer>
    </div>
  );
}

/**
 * SPA routes render this into the document at build time, so the shell paints
 * immediately while the route component boots in the browser.
 */
export function Loading() {
  return <p data-testid="loading">Loading…</p>;
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht Static Example",
  };
}
