import type { ShellProps } from "@pracht/core";
import { IconBrandGithub } from "@tabler/icons-preact";
import "../styles/global.css";
import { inter } from "../fonts";

export function Shell({ children }: ShellProps) {
  return (
    <div style={inter.style}>
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
          <span class="footer-copy">pracht — one app graph, for browsers and for agents.</span>
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
    title: "pracht — one app graph, projected to browsers and to agents.",
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content:
          "The Preact framework that resolves routes, loaders, API routes, and capabilities into one explicit app graph — then projects it to browsers and to agents over HTTP, WebMCP, remote MCP, and llms.txt. Per-route render modes (SSG/SSR/ISG/SPA) and thin adapters for Cloudflare, Vercel, Netlify, and Node.js.",
      },
      { property: "og:title", content: "pracht — one app graph, two kinds of caller." },
      {
        property: "og:description",
        content:
          "One explicit app graph, projected to browsers and to agents. Preact-sized, per-route render modes, deploy anywhere.",
      },
    ],
    fonts: [inter],
  };
}
