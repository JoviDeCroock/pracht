import type { ShellProps } from "@pracht/core";
import "../styles/global.css";

export function Shell({ children }: ShellProps) {
  return (
    <div class="marketing">
      <header class="site-header">
        <div class="header-inner">
          <a href="/" class="logo">
            <span class="logo-mark">L</span>
            Launchpad
          </a>
          <nav class="header-nav">
            <a href="/">Home</a>
            <a href="/blog/why-pracht">Blog</a>
            <a href="/pricing">Pricing</a>
            <a href="/api/auth/login" class="btn-signin">
              Sign in
            </a>
          </nav>
        </div>
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
