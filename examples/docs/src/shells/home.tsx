import type { ShellProps } from "@pracht/core";
import { IconBrandGithub } from "@tabler/icons-preact";
import "../styles/global.css";

export function Shell({ children }: ShellProps) {
  return (
    <div>
      <header class="site-header">
        <div class="inner">
          <a href="/" class="logo">
            <div class="logo-mark">v</div>
            pracht
          </a>
          <nav class="header-nav">
            <a href="/docs/routing">Docs</a>
          </nav>
          <div class="header-right">
            <a
              href="https://github.com/JoviDeCroock/pracht"
              class="github-link"
              target="_blank"
              rel="noopener"
            >
              <IconBrandGithub size={15} stroke={1.5} />
              GitHub
            </a>
          </div>
        </div>
      </header>
      {children}
      <footer class="site-footer">
        <div class="inner">
          <span class="footer-copy">pracht — Preact-first. Vite-native. Explicit routing.</span>
          <div class="footer-links">
            <a href="/docs/routing">Docs</a>
            <a href="/docs/adapters">Adapters</a>
            <a href="https://github.com/JoviDeCroock/pracht" target="_blank" rel="noopener">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function head() {
  return {
    title: "pracht — Preact-first. Vite-native. Explicit routing.",
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content:
          "The Preact framework with explicit routing, per-route render modes (SSG/SSR/ISG/SPA), and thin deployment adapters for Cloudflare, Vercel, and Node.js.",
      },
      { property: "og:title", content: "pracht — Build with Preact. Deploy everywhere." },
      {
        property: "og:description",
        content: "Explicit routing. Per-route render modes. Edge-ready.",
      },
    ],
    link: [
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: "",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;550;600;650;700&display=swap",
      },
    ],
  };
}
