const STRENGTHS = [
  {
    title: "Routes are a map, not a scavenger hunt",
    detail:
      "An agent can open one manifest and understand URLs, render modes, shells, middleware, and route IDs without crawling a directory tree.",
  },
  {
    title: "Rendering intent is explicit",
    detail:
      "SSG, SSR, ISG, and SPA are visible route facts. Agents can tune performance by changing configuration instead of inferring behavior from conventions.",
  },
  {
    title: "Server code has a clear boundary",
    detail:
      "Loaders run on the server and are stripped from client modules. Agents can safely add data fetching without accidentally shipping secrets.",
  },
  {
    title: "Docs can be read as Markdown",
    detail:
      "Routes can export markdown so browsers get the app and agents get source content with Accept: text/markdown.",
  },
];

const AGENT_TASKS = [
  "Find every authenticated route",
  "Convert pricing from SSR to ISG",
  "Add a public docs page with SSG",
  "Audit loaders for secret leakage",
  "Generate a sitemap from the manifest",
  "Explain what deploys to Cloudflare vs Vercel",
];

export const markdown = `# Launchpad Agent Briefing

This page is the agent-readable briefing for the Pracht showcase.

## Why Pracht works well with agents

- The route manifest is explicit: path, component, shell, middleware, render mode, and route ID live together.
- Render modes are strings agents can inspect and change safely: ssg, ssr, isg, spa.
- Loaders stay server-side, so agents have a clear place to add data access without leaking secrets to the browser.
- Markdown content negotiation lets agents request source content from the same canonical URL humans open in a browser.
- CLI inspection commands can expose the app graph as JSON for automation.

## Demo tasks

1. Find every route protected by auth middleware.
2. Explain why /pricing uses ISG instead of SSR.
3. Add a new SSG docs route without changing layout folders.
4. Audit all loaders and confirm they run server-side.
5. Produce a deployment note for Node, Cloudflare, and Vercel.
`;

export function head() {
  return {
    title: "Agent Briefing — Launchpad",
    meta: [
      {
        name: "description",
        content:
          "A Pracht showcase page demonstrating why explicit manifests and Markdown negotiation work well for AI agents.",
      },
    ],
  };
}

export function Component() {
  return (
    <article class="agent-page">
      <section class="agent-hero">
        <div class="hero-badge">
          <span class="hero-badge-dot" />
          Agent-native by design
        </div>
        <h1>
          A framework an agent can
          <br />
          <span class="gradient-text">actually understand.</span>
        </h1>
        <p>
          Pracht's superpower is not only that humans can read the route manifest. It is that tools
          can read it too. The app graph is explicit, render modes are declarative, and content can
          be served as Markdown from the same URL.
        </p>
        <div class="agent-actions">
          <a href="/" class="btn">
            View product demo
          </a>
          <a href="/agents" class="btn btn-accent">
            Browser version
          </a>
        </div>
      </section>

      <section class="agent-terminal" aria-label="Agent reads Pracht route facts">
        <div class="code-header">
          <div class="code-dots">
            <span />
            <span />
            <span />
          </div>
          <span class="code-title">agent session</span>
        </div>
        <pre>
          <code>
            <span class="cmt"># Same URL, source content for tools</span>
            {"\n"}
            <span class="kw">curl</span>
            {" -H "}
            <span class="str">"Accept: text/markdown"</span>
            {" https://launchpad.example/agents"}
            {"\n\n"}
            <span class="cmt"># Inspect the app graph as structured data</span>
            {"\n"}
            <span class="kw">pnpm</span>
            {" pracht inspect routes --json"}
            {"\n\n"}
            <span class="cmt"># The answer is visible in src/routes.ts</span>
            {"\n"}
            <span class="fn">route</span>
            {"("}
            <span class="str">"/pricing"</span>
            {", ..., { "}
            <span class="prop">render</span>
            {": "}
            <span class="str">"isg"</span>
            {", "}
            <span class="prop">revalidate</span>
            {": timeRevalidate(3600) })"}
          </code>
        </pre>
      </section>

      <section class="agent-grid">
        {STRENGTHS.map((strength) => (
          <div key={strength.title} class="agent-card">
            <h2>{strength.title}</h2>
            <p>{strength.detail}</p>
          </div>
        ))}
      </section>

      <section class="agent-briefing">
        <div>
          <p class="eyebrow">Demo prompt</p>
          <h2>Ask an agent to improve this app</h2>
          <p>
            The impressive demo is to give an agent a real product request and watch it operate on
            route-level facts instead of guessing framework conventions.
          </p>
        </div>
        <ul>
          {AGENT_TASKS.map((task) => (
            <li key={task}>{task}</li>
          ))}
        </ul>
      </section>
    </article>
  );
}
