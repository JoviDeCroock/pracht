import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

const SURFACES = [
  {
    tag: "browser",
    title: "The product",
    detail:
      "<Form capability> posts to the capability endpoint — with a form-encoded fallback when JavaScript never arrives.",
  },
  {
    tag: "server",
    title: "The loader",
    detail:
      "invokeCapability() from SSR runs the same validation and middleware chain, no HTTP round trip.",
  },
  {
    tag: "webmcp",
    title: "The tab",
    detail:
      "An in-browser agent gets the capability as a page tool, acting as the signed-in user in their own session.",
  },
  {
    tag: "http",
    title: "The network",
    detail:
      "A remote agent signs its request with RFC 9421 and gets a verified identity, policy checks, and an audit event.",
  },
  {
    tag: "mcp",
    title: "The tool list",
    detail:
      "POST /mcp serves the same capabilities as MCP tools over stateless Streamable HTTP — minus the destructive one.",
  },
];

const MODES = [
  { tag: "ssg", title: "This page", detail: "Pre-rendered at build. Zero server cost." },
  {
    tag: "isg",
    title: "Pricing",
    detail: "Add a revalidate policy and the page rebuilds on a timer, no code change.",
  },
  { tag: "ssr", title: "Dashboard", detail: "Per-request, personalised, always current." },
  { tag: "spa", title: "Settings", detail: "Client-only. Shell paints instantly, no SEO needed." },
];

const GUARANTEES = [
  {
    title: "Private by default",
    detail:
      "No loader and no API route is ever inferred as a tool. A capability without an explicit expose is unreachable over the network.",
  },
  {
    title: "Destructive is gated, not annotated",
    detail:
      "A destructive capability cannot be exposed to WebMCP. HTTP and explicitly enabled remote MCP dispatches are refused until the server verifies approval.",
  },
  {
    title: "Identity is verified, not claimed",
    detail:
      "Web Bot Auth checks an Ed25519 signature over the request before context.agent exists. Unverifiable means null, never a partial identity.",
  },
  {
    title: "Widening shows up in review",
    detail:
      "pracht plan marks a new exposure, a dropped required field or a raised bound with a ! — the diff answers 'did this let agents reach more?'",
  },
];

export async function loader(_args: LoaderArgs) {
  return { surfaces: SURFACES, modes: MODES, guarantees: GUARANTEES };
}

export function head() {
  return {
    title: "Launchpad — one product, two audiences",
    meta: [
      {
        name: "description",
        content:
          "A Pracht showcase: define an operation once, project it to browsers, forms, in-page agents and remote agents — with one trust layer.",
      },
      { property: "og:title", content: "Launchpad — one product, two audiences" },
      {
        property: "og:description",
        content:
          "Capabilities, Web Bot Auth, human approvals and an audit trail, in one small Preact app.",
      },
    ],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <>
      <section class="hero">
        <div class="hero-bg" />
        <div class="hero-grid" />
        <div class="hero-inner">
          <div class="hero-badge">
            <span class="hero-badge-dot" />
            Capability graph &middot; agent trust layer
          </div>

          <h1>
            Build the product once.
            <br />
            <span class="gradient-text">Let their agents use it too.</span>
          </h1>

          <p class="hero-sub">
            Launchpad is a small project-management app. Its six operations are defined once, with
            one schema, one middleware chain and one <code>run()</code> — then projected to the
            browser, to progressive-enhancement forms, to in-page agents, to signed remote callers,
            and to MCP tools at <code>/mcp</code>. Same business rules, by construction.
          </p>

          <div class="hero-actions">
            <a href="/playground" class="btn btn-accent">
              Open the playground
            </a>
            <a href="/agents" class="btn">
              Read the agent briefing
            </a>
          </div>

          <div class="surfaces-grid">
            {data.surfaces.map((surface) => (
              <div key={surface.tag} class="surface-card">
                <span class={`mode-tag ${surface.tag}`}>{surface.tag}</span>
                <h3>{surface.title}</h3>
                <p>{surface.detail}</p>
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
              <span class="code-title">src/capabilities/projects-archive.ts</span>
            </div>
            <pre>
              <code>
                <span class="kw">export default</span> <span class="fn">defineCapability</span>
                {"({\n  "}
                <span class="prop">title</span>
                {": "}
                <span class="str">"Archive project"</span>
                {",\n  "}
                <span class="prop">input</span>
                {": { type: "}
                <span class="str">"object"</span>
                {", properties: { projectId: { type: "}
                <span class="str">"string"</span>
                {" } } },\n  "}
                <span class="prop">effect</span>
                {": "}
                <span class="str">"destructive"</span>
                {",   "}
                <span class="cmt">// → webmcp/mcp exposure is a build error</span>
                {"\n  "}
                <span class="prop">expose</span>
                {": { http: true }, "}
                <span class="cmt">// → prepare/commit + a human approval</span>
                {"\n  "}
                <span class="kw">async</span> <span class="fn">run</span>
                {"({ input }) { … },\n});"}
              </code>
            </pre>
          </div>
        </div>
      </section>

      <section class="band">
        <div class="band-inner">
          <p class="eyebrow">The security model is the product</p>
          <h2>Four things the framework refuses to let you get wrong</h2>
          <div class="guarantee-grid">
            {data.guarantees.map((guarantee) => (
              <div key={guarantee.title} class="guarantee-card">
                <h3>{guarantee.title}</h3>
                <p>{guarantee.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section class="band band-alt">
        <div class="band-inner">
          <p class="eyebrow">Still a web framework</p>
          <h2>Every route renders the way it should</h2>
          <div class="modes-grid">
            {data.modes.map((mode) => (
              <div key={mode.tag} class="mode-card">
                <span class={`mode-tag ${mode.tag}`}>{mode.tag}</span>
                <h3>{mode.title}</h3>
                <p>{mode.detail}</p>
              </div>
            ))}
          </div>
          <p class="band-foot">
            One manifest, one build, one deployment — and the same manifest is where the capability
            graph, the trust config and the machine-enforced constraints live.
          </p>
        </div>
      </section>
    </>
  );
}
