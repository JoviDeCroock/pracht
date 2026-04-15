import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

const MODES = [
  {
    tag: "ssg",
    title: "Marketing & docs",
    description:
      "This page was pre-rendered at build time. Zero server cost, instant load from any CDN.",
  },
  {
    tag: "isg",
    title: "Pricing & catalogs",
    description: "Our pricing page revalidates hourly. Fast like static, fresh like dynamic.",
  },
  {
    tag: "ssr",
    title: "Dashboards & feeds",
    description:
      "The app dashboard renders per-request with your data. Always current, always personal.",
  },
  {
    tag: "spa",
    title: "Settings & editors",
    description: "Settings loads client-side only. No SEO needed, the shell paints instantly.",
  },
];

export async function loader(_args: LoaderArgs) {
  return { modes: MODES };
}

export function head() {
  return {
    title: "Launchpad — Ship faster with per-route rendering",
    meta: [
      { property: "og:title", content: "Launchpad — Ship faster with per-route rendering" },
      {
        property: "og:description",
        content: "A Pracht showcase: one codebase, four render modes, each route picks what fits.",
      },
    ],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="hero">
      <div class="hero-bg" />
      <div class="hero-grid" />
      <div class="hero-inner">
        <div class="hero-badge">
          <span class="hero-badge-dot" />
          Built with Pracht
        </div>

        <h1>
          Every route renders
          <br />
          <span class="gradient-text">the way it should.</span>
        </h1>

        <p class="hero-sub">
          Static marketing. Dynamic dashboards. Revalidating pricing. Client-only settings. One
          codebase, one manifest, one build.
        </p>

        <div class="modes-grid">
          {data.modes.map((mode) => (
            <div key={mode.tag} class="mode-card">
              <span class={`mode-tag ${mode.tag}`}>{mode.tag}</span>
              <h3>{mode.title}</h3>
              <p>{mode.description}</p>
            </div>
          ))}
        </div>

        <div class="code-preview">
          <div class="code-header">
            <div class="code-dots">
              <span />
              <span />
              <span />
            </div>
            <span class="code-title">routes.ts</span>
          </div>
          <pre>
            <code>
              <span class="kw">route</span>
              {"("}
              <span class="str">"/"</span>
              {",        ...  { "}
              <span class="prop">render</span>
              {": "}
              <span class="str">"ssg"</span>
              {" })  "}
              <span class="cmt">// this page</span>
              {"\n"}
              <span class="kw">route</span>
              {"("}
              <span class="str">"/pricing"</span>
              {", ...  { "}
              <span class="prop">render</span>
              {": "}
              <span class="str">"isg"</span>
              {" })  "}
              <span class="cmt">// revalidates hourly</span>
              {"\n"}
              <span class="kw">route</span>
              {"("}
              <span class="str">"/app"</span>
              {",     ...  { "}
              <span class="prop">render</span>
              {": "}
              <span class="str">"ssr"</span>
              {" })  "}
              <span class="cmt">// per-request</span>
              {"\n"}
              <span class="kw">route</span>
              {"("}
              <span class="str">"/settings"</span>
              {",...  { "}
              <span class="prop">render</span>
              {": "}
              <span class="str">"spa"</span>
              {" })  "}
              <span class="cmt">// client-only</span>
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}
