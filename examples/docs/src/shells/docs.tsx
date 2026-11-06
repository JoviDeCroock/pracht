import { useLocation } from "@pracht/core";
import type { ShellProps } from "@pracht/core";
import type { Icon } from "@tabler/icons-preact";
import {
  IconActivity,
  IconAdjustments,
  IconApps,
  IconBolt,
  IconBook,
  IconBrandGithub,
  IconBroadcast,
  IconCloud,
  IconFileText,
  IconForms,
  IconGauge,
  IconKey,
  IconLanguage,
  IconLayout,
  IconLock,
  IconMenu2,
  IconPalette,
  IconPhoto,
  IconPlug,
  IconPresentation,
  IconRefresh,
  IconRobot,
  IconRocket,
  IconRoute,
  IconServer,
  IconShield,
  IconShieldCheck,
  IconSitemap,
  IconSparkles,
  IconTerminal2,
  IconTestPipe,
  IconTriangle,
  IconTypography,
  IconUserBolt,
  IconWorld,
  IconWorldBolt,
} from "@tabler/icons-preact";

import DocsEnhancer from "../islands/DocsEnhancer.tsx";
import DocsSearch from "../islands/DocsSearch.tsx";
import PageActions from "../islands/PageActions.tsx";
import { Logo } from "../components/Logo.tsx";
import { NAV, navContext, sectionId, type NavIcon } from "../nav.ts";
import { SITE_NAME, SITE_ORIGIN, absoluteUrl } from "../site.ts";
import "../styles/global.css";
import { inter } from "../fonts";

const ICONS: Record<NavIcon, Icon> = {
  activity: IconActivity,
  adjustments: IconAdjustments,
  apps: IconApps,
  bolt: IconBolt,
  book: IconBook,
  broadcast: IconBroadcast,
  cloud: IconCloud,
  "file-text": IconFileText,
  forms: IconForms,
  gauge: IconGauge,
  key: IconKey,
  language: IconLanguage,
  layout: IconLayout,
  lock: IconLock,
  palette: IconPalette,
  photo: IconPhoto,
  plug: IconPlug,
  presentation: IconPresentation,
  refresh: IconRefresh,
  robot: IconRobot,
  rocket: IconRocket,
  route: IconRoute,
  server: IconServer,
  shield: IconShield,
  "shield-check": IconShieldCheck,
  sitemap: IconSitemap,
  sparkles: IconSparkles,
  terminal: IconTerminal2,
  test: IconTestPipe,
  triangle: IconTriangle,
  typography: IconTypography,
  "user-bolt": IconUserBolt,
  world: IconWorld,
  "world-bolt": IconWorldBolt,
};

const REPO = "https://github.com/JoviDeCroock/pracht";

function Sidebar({ currentPath }: { currentPath: string }) {
  return (
    <>
      {NAV.map((section) => (
        <div key={section.label} class="sidebar-section">
          <div class="sidebar-label">{section.label}</div>
          <ul class="sidebar-nav">
            {section.links.map(({ href, title, icon }) => {
              const Glyph = ICONS[icon];
              const active = currentPath === href;
              return (
                <li key={href}>
                  <a
                    href={href}
                    class={active ? "active" : undefined}
                    aria-current={active ? "page" : undefined}
                  >
                    <span class="sidebar-icon" aria-hidden="true">
                      <Glyph size={14} stroke={1.75} />
                    </span>
                    {title}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}

export function Shell({ children }: ShellProps) {
  const currentPath = normalizePath(useLocation().pathname);
  const { entry, prev, next } = navContext(currentPath);
  const sourceFile = entry ? `${currentPath.slice("/docs/".length).replace("/", "-")}.md` : null;

  return (
    // Apply the generated stack to the shell root, including its adjusted
    // fallback face, so every descendant inherits it.
    <div class="docs-layout" style={inter.style}>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header class="site-header">
        <div class="inner">
          <button
            type="button"
            class="nav-toggle"
            popovertarget="docs-nav"
            aria-label="Open navigation"
          >
            <IconMenu2 size={18} stroke={1.75} />
          </button>
          <a href="/" class="logo" aria-label="pracht home">
            <Logo />
            pracht
          </a>
          <nav class="header-nav" aria-label="Site">
            <a href="/docs" class="active">
              Docs
            </a>
          </nav>
          <div class="header-right">
            <DocsSearch client="idle" />
            <a href={REPO} class="github-link" target="_blank" rel="noopener" aria-label="GitHub">
              <IconBrandGithub size={15} stroke={1.5} />
              <span class="github-label">GitHub</span>
            </a>
          </div>
        </div>
      </header>
      <div class="docs-body">
        <nav id="docs-nav" class="docs-sidebar" popover="auto" aria-label="Docs">
          <Sidebar currentPath={currentPath} />
        </nav>
        <main id="main" class="docs-content" tabIndex={-1}>
          {entry ? (
            <div class="doc-toolbar">
              <nav class="breadcrumb" aria-label="Breadcrumb">
                <a href="/docs">Docs</a>
                <span class="breadcrumb-sep" aria-hidden="true">
                  /
                </span>
                <a href={`/docs#${sectionId(entry.section)}`}>{entry.section}</a>
              </nav>
              <PageActions path={currentPath} title={entry.title} client="idle" />
            </div>
          ) : null}
          {children}
          {entry ? (
            <footer class="doc-footer">
              <nav class="doc-nav" aria-label="Previous and next page">
                {prev ? (
                  <a href={prev.href} class="doc-nav-card prev" rel="prev">
                    <span class="doc-nav-dir">Previous</span>
                    <span class="doc-nav-title">← {prev.title}</span>
                  </a>
                ) : (
                  <span />
                )}
                {next ? (
                  <a href={next.href} class="doc-nav-card next" rel="next">
                    <span class="doc-nav-dir">Next</span>
                    <span class="doc-nav-title">{next.title} →</span>
                  </a>
                ) : (
                  <span />
                )}
              </nav>
              <p class="doc-edit">
                <a
                  href={`${REPO}/edit/main/examples/docs/src/routes/docs/${sourceFile}`}
                  target="_blank"
                  rel="noopener"
                >
                  Edit this page on GitHub
                </a>
                <span aria-hidden="true">·</span>
                <a href={`${currentPath}.md`}>View as Markdown</a>
              </p>
            </footer>
          ) : null}
        </main>
      </div>
      <DocsEnhancer client="idle" />
    </div>
  );
}

export function head({ url }: { url: URL }) {
  const path = normalizePath(url.pathname);
  const { entry } = navContext(path);
  const canonical = absoluteUrl(path);
  const breadcrumbs = entry
    ? {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "Docs",
            item: absoluteUrl("/docs"),
          },
          {
            "@type": "ListItem",
            position: 2,
            name: entry.section,
            item: absoluteUrl(`/docs#${sectionId(entry.section)}`),
          },
          { "@type": "ListItem", position: 3, name: entry.title, item: canonical },
        ],
      }
    : null;

  return {
    lang: "en",
    title: `Docs — ${SITE_NAME}`,
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#09090b", media: "(prefers-color-scheme: dark)" },
      { name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" },
      { property: "og:site_name", content: SITE_NAME },
      { property: "og:type", content: entry ? "article" : "website" },
      // Only real pages are canonical; the 404 page and redirects are not.
      ...(entry ? [{ property: "og:url", content: canonical }] : []),
      { property: "og:image", content: `${SITE_ORIGIN}/og.png` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `${SITE_ORIGIN}/og.png` },
    ],
    link: [
      ...(entry ? [{ rel: "canonical", href: canonical }] : []),
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      // The docs index for agents, advertised the same way the homepage's
      // `Link` header does.
      { rel: "describedby", href: "/llms.txt", type: "text/markdown" },
    ],
    script: breadcrumbs
      ? [
          {
            type: "application/ld+json",
            children: JSON.stringify(breadcrumbs),
          },
        ]
      : [],
    fonts: [inter],
  };
}
