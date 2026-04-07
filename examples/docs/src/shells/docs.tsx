import { useLocation } from "viact";
import type { ShellProps } from "viact";
import "../styles/global.css";

const NAV = [
  {
    label: "Getting Started",
    links: [
      { href: "/docs/getting-started", icon: "🚀", title: "Quick Start" },
      { href: "/docs/routing", icon: "🗺", title: "Routing" },
    ],
  },
  {
    label: "Core Concepts",
    links: [
      { href: "/docs/rendering", icon: "⚡", title: "Rendering Modes" },
      { href: "/docs/data-loading", icon: "📡", title: "Data Loading" },
      { href: "/docs/api-routes", icon: "🔌", title: "API Routes" },
      { href: "/docs/middleware", icon: "🛡", title: "Middleware" },
      { href: "/docs/shells", icon: "📐", title: "Shells" },
    ],
  },
  {
    label: "Guides",
    links: [
      { href: "/docs/cli", icon: "⌨", title: "CLI" },
      { href: "/docs/deployment", icon: "🚢", title: "Deployment" },
    ],
  },
  {
    label: "Advanced",
    links: [
      { href: "/docs/prefetching", icon: "🔮", title: "Prefetching" },
      { href: "/docs/performance", icon: "⚡", title: "Performance" },
    ],
  },
  {
    label: "Recipes",
    links: [
      { href: "/docs/recipes/i18n", icon: "🌍", title: "i18n" },
      { href: "/docs/recipes/auth", icon: "🔒", title: "Authentication" },
      { href: "/docs/recipes/forms", icon: "📝", title: "Forms" },
      { href: "/docs/recipes/testing", icon: "🧪", title: "Testing" },
    ],
  },
  {
    label: "Reference",
    links: [{ href: "/docs/adapters", icon: "🌐", title: "Adapters" }],
  },
];

function NavLink({
  href,
  icon,
  title,
  currentPath,
}: {
  href: string;
  icon: string;
  title: string;
  currentPath: string;
}) {
  const active = currentPath === href;
  return (
    <a href={href} class={active ? "active" : ""}>
      <span class="sidebar-icon">{icon}</span>
      {title}
    </a>
  );
}

export function Shell({ children }: ShellProps) {
  const { pathname: currentPath } = useLocation();
  const docsActive = currentPath.startsWith("/docs");

  return (
    <div class="docs-layout">
      <header class="site-header">
        <div class="inner">
          <a href="/" class="logo">
            <div class="logo-mark">v</div>
            viact
          </a>
          <nav class="header-nav">
            <a href="/docs/getting-started" class={docsActive ? "active" : ""}>
              Docs
            </a>
          </nav>
          <div class="header-right">
            <a
              href="https://github.com/JoviDeCroock/viact"
              class="github-link"
              target="_blank"
              rel="noopener"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
              GitHub
            </a>
          </div>
        </div>
      </header>
      <div class="docs-body">
        <aside class="docs-sidebar">
          {NAV.map((section) => (
            <div key={section.label} class="sidebar-section">
              <div class="sidebar-label">{section.label}</div>
              <nav class="sidebar-nav">
                {section.links.map((link) => (
                  <NavLink key={link.href} {...link} currentPath={currentPath} />
                ))}
              </nav>
            </div>
          ))}
        </aside>
        <main class="docs-content">{children}</main>
      </div>
    </div>
  );
}

export function head() {
  return {
    title: "Docs — viact",
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content:
          "viact documentation — routing, rendering modes, data loading, and deployment adapters.",
      },
    ],
  };
}
