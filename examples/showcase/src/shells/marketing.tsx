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
            <a href="/playground">Playground</a>
            <a href="/agents">Agents</a>
            <a href="/pricing">Pricing</a>
            <a href="/blog/why-pracht">Blog</a>
            <form action="/api/auth/login" method="post">
              <button type="submit" class="btn-signin">
                Sign in
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer class="site-footer">
        <p>
          Built with Pracht — one capability contract for browsers, forms, in-page agents and signed
          remote callers. <a href="/llms.txt">/llms.txt</a>
        </p>
      </footer>
    </div>
  );
}

export function head() {
  return {
    title: "Launchpad — one product, two audiences",
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content:
          "Launchpad is a Pracht showcase: one capability contract serving humans and agents, with a real trust layer.",
      },
    ],
  };
}
