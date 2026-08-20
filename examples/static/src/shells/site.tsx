import { Link, type ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="site-shell">
      <header>
        <strong>Pracht Static</strong>
        {/* Typed links resolve route ids to URLs, so they pick up a Vite
            `base` automatically. A hand-written <a href="/about"> would keep
            pointing at the origin root under a sub-path deploy. */}
        <nav>
          <Link route="home">Home</Link>
          <Link route="about">About</Link>
          <Link route="plain">Plain</Link>
          <Link route="post" params={{ slug: "hello-world" }}>
            First post
          </Link>
          <Link route="dashboard">Dashboard</Link>
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
