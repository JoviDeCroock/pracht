import { useLocation } from "@pracht/core";
import type { ShellProps } from "@pracht/core";
import type { Icon } from "@tabler/icons-preact";
import {
  IconRocket,
  IconSitemap,
  IconBolt,
  IconServerBolt,
  IconPlug,
  IconShield,
  IconLayout,
  IconPalette,
  IconTerminal2,
  IconCloud,
  IconGauge,
  IconWorld,
  IconLock,
  IconForms,
  IconTestPipe,
  IconTriangle,
  IconRefresh,
  IconBrandGithub,
  IconSparkles,
} from "@tabler/icons-preact";
import "../styles/global.css";

const NAV = [
  {
    label: "Getting Started",
    links: [
      { href: "/docs/getting-started", Icon: IconRocket, title: "Quick Start" },
      { href: "/docs/why-pracht", Icon: IconSparkles, title: "Why Pracht?" },
      { href: "/docs/routing", Icon: IconSitemap, title: "Routing" },
    ],
  },
  {
    label: "Core Concepts",
    links: [
      { href: "/docs/rendering", Icon: IconBolt, title: "Rendering Modes" },
      { href: "/docs/data-loading", Icon: IconServerBolt, title: "Data Loading" },
      { href: "/docs/api-routes", Icon: IconPlug, title: "API Routes" },
      { href: "/docs/middleware", Icon: IconShield, title: "Middleware" },
      { href: "/docs/shells", Icon: IconLayout, title: "Shells" },
      { href: "/docs/styling", Icon: IconPalette, title: "Styling" },
    ],
  },
  {
    label: "Guides",
    links: [
      { href: "/docs/cli", Icon: IconTerminal2, title: "CLI" },
      { href: "/docs/deployment", Icon: IconCloud, title: "Deployment" },
    ],
  },
  {
    label: "Advanced",
    links: [
      { href: "/docs/prefetching", Icon: IconBolt, title: "Prefetching" },
      { href: "/docs/performance", Icon: IconGauge, title: "Performance" },
    ],
  },
  {
    label: "Recipes",
    links: [
      { href: "/docs/recipes/i18n", Icon: IconWorld, title: "i18n" },
      { href: "/docs/recipes/auth", Icon: IconLock, title: "Authentication" },
      { href: "/docs/recipes/forms", Icon: IconForms, title: "Forms" },
      { href: "/docs/recipes/testing", Icon: IconTestPipe, title: "Testing" },
      {
        href: "/docs/recipes/fullstack-cloudflare",
        Icon: IconCloud,
        title: "Full-Stack Cloudflare",
      },
      { href: "/docs/recipes/fullstack-vercel", Icon: IconTriangle, title: "Full-Stack Vercel" },
    ],
  },
  {
    label: "Migration",
    links: [{ href: "/docs/migrate/nextjs", Icon: IconRefresh, title: "From Next.js" }],
  },
  {
    label: "Reference",
    links: [{ href: "/docs/adapters", Icon: IconPlug, title: "Adapters" }],
  },
];

function NavLink({
  href,
  Icon,
  title,
  currentPath,
}: {
  href: string;
  Icon: Icon;
  title: string;
  currentPath: string;
}) {
  const active = currentPath === href;
  return (
    <a href={href} class={active ? "active" : ""}>
      <span class="sidebar-icon">
        <Icon size={14} stroke={1.75} />
      </span>
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
            pracht
          </a>
          <nav class="header-nav">
            <a href="/docs/getting-started" class={docsActive ? "active" : ""}>
              Docs
            </a>
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
    title: "Docs — pracht",
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        name: "description",
        content:
          "pracht documentation — routing, rendering modes, data loading, and deployment adapters.",
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
