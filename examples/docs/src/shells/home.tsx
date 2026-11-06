import type { ShellProps } from "@pracht/core";
import { IconBrandGithub } from "@tabler/icons-preact";
import { Logo } from "../components/Logo";
import { SITE_ORIGIN } from "../site";
import "../styles/global.css";
import { inter } from "../fonts";

export function Shell({ children }: ShellProps) {
  return (
    <div style={inter.style}>
      <header class="site-header">
        <div class="inner">
          <a href="/" class="logo" aria-label="pracht home">
            <Logo />
            pracht
          </a>
          <nav class="header-nav" aria-label="Site">
            <a href="/docs/getting-started">Docs</a>
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
            <a href="/docs/getting-started">Docs</a>
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
  const description =
    "pracht is a full-stack Preact framework on Vite. Pick SSG, SSR, ISG, or SPA per route, and expose typed capabilities that agents call over HTTP, WebMCP, and MCP.";
  const title = "pracht — the Preact framework for browsers and agents";
  return {
    lang: "en",
    title,
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "description", content: description },
      { name: "theme-color", content: "#09090b" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "pracht" },
      { property: "og:url", content: `${SITE_ORIGIN}/` },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:image", content: `${SITE_ORIGIN}/og.png` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: `${SITE_ORIGIN}/og.png` },
    ],
    link: [
      { rel: "canonical", href: `${SITE_ORIGIN}/` },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
    script: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "pracht",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Node.js, Cloudflare Workers, Vercel, Netlify",
          description,
          url: `${SITE_ORIGIN}/`,
          license: "https://opensource.org/licenses/MIT",
          codeRepository: "https://github.com/JoviDeCroock/pracht",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        }),
      },
    ],
    fonts: [inter],
  };
}
