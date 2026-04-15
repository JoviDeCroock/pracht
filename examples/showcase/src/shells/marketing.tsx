import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="marketing">
      <header class="site-header">
        <a href="/" class="logo">
          Launchpad
        </a>
        <nav>
          <a href="/">Home</a>
          <a href="/blog/why-pracht">Blog</a>
          <a href="/pricing">Pricing</a>
          <a href="/app">Sign in</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer class="site-footer">
        <p>Built with Pracht — Preact-first, Vite-native, per-route rendering.</p>
      </footer>
    </div>
  );
}

export function head() {
  return {
    title: "Launchpad — Ship faster",
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content: "Launchpad helps teams ship software faster. A Pracht showcase.",
      },
    ],
  };
}
