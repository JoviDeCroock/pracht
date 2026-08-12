import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="site-shell">
      <header>
        <strong>Pracht Static</strong>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/plain">Plain</a>
          <a href="/posts/hello-world">First post</a>
          <a href="/dashboard">Dashboard</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>Deployed from dist/client with zero server.</footer>
    </div>
  );
}

export function Loading() {
  return <p id="shell-loading">Loading page…</p>;
}

export function head() {
  return {
    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
    title: "Pracht Static Example",
  };
}
