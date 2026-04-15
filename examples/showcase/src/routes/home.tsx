import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return {
    features: [
      {
        title: "SSG — Marketing & docs",
        description:
          "This page was pre-rendered at build time. Zero server cost, instant load from any CDN.",
      },
      {
        title: "ISG — Pricing & catalogs",
        description: "Our pricing page revalidates hourly. Fast like static, fresh like dynamic.",
      },
      {
        title: "SSR — Dashboards & feeds",
        description:
          "The app dashboard renders per-request with your data. Always current, always personal.",
      },
      {
        title: "SPA — Settings & editors",
        description: "Settings loads client-side only. No SEO needed, the shell paints instantly.",
      },
    ],
  };
}

export function head() {
  return {
    title: "Launchpad — Ship faster with per-route rendering",
    meta: [
      {
        property: "og:title",
        content: "Launchpad — Ship faster with per-route rendering",
      },
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
      <h1>Every route renders the way it should.</h1>
      <p class="hero-sub">
        Static marketing. Dynamic dashboards. Revalidating pricing. Client-only settings. One
        codebase, one manifest, one build.
      </p>
      <div class="features">
        {data.features.map((f) => (
          <div key={f.title} class="feature-card">
            <h3>{f.title}</h3>
            <p>{f.description}</p>
          </div>
        ))}
      </div>
      <pre class="code-preview">
        {`route("/",        ...  { render: "ssg" })  // this page
route("/pricing", ...  { render: "isg" })  // revalidates hourly
route("/app",     ...  { render: "ssr" })  // per-request
route("/settings",...  { render: "spa" })  // client-only`}
      </pre>
    </section>
  );
}
