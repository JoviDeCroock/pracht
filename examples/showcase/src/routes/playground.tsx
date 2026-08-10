import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";
import { useEffect, useState } from "preact/hooks";
import { capabilities, useCapability } from "virtual:pracht/capabilities";
import { ArchiveFlow } from "../components/archive-flow.tsx";
import { readSession } from "../server/session.ts";

export async function loader({ request }: LoaderArgs) {
  return { signedIn: readSession(request) !== null };
}

export function head() {
  return {
    title: "Capability playground — Launchpad",
    meta: [
      {
        name: "description",
        content:
          "Call Launchpad's capabilities from the browser: the same endpoints, schemas and policy an agent gets.",
      },
    ],
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <article class="playground">
      <header class="page-head playground-head">
        <div>
          <p class="eyebrow">Same endpoints an agent calls</p>
          <h1>
            Capability <span class="gradient-text">playground</span>
          </h1>
          <p class="page-sub">
            Everything below dispatches to <code>/api/capabilities/*</code> — the identical URL,
            schema, middleware chain and policy an autonomous caller hits. Watch the results land in
            the <a href="/app/audit">audit trail</a>.
          </p>
        </div>
        <WebMcpStatus />
      </header>

      <WhoAmIPanel />
      <BriefPanel />
      <SearchPanel />

      <section class="panel">
        <p class="eyebrow">write &middot; projects.create</p>
        <h2>&lt;Form capability&gt;</h2>
        <p class="panel-sub">
          Progressive enhancement all the way down: with JavaScript this posts JSON and revalidates
          the page; without it, the endpoint accepts the form-encoded body, coerces the fields onto
          the input schema, and answers with a 303 back here.
        </p>
        <CreatePanel />
      </section>

      <section class="panel panel-danger">
        <p class="eyebrow">destructive &middot; projects.archive</p>
        <h2>Prepare, then wait for a person</h2>
        <p class="panel-sub">
          {data.signedIn ? (
            <>
              You are signed in, so proposals bind to your user id. Request an archive, then approve
              it in the <a href="/app/approvals">inbox</a>.
            </>
          ) : (
            <>
              You are not signed in and this request carries no verified agent identity, so the
              confirmation flow will <strong>fail closed</strong> with{" "}
              <code>confirmation_unavailable</code> — there is nobody to bind the proposal to. Try
              it, then sign in and try again.
            </>
          )}
        </p>
        <ArchiveFlow projectId="corvus" name="Corvus" />
      </section>

      <section class="panel">
        <p class="eyebrow">Housekeeping</p>
        <h2>Reset the demo</h2>
        <p class="panel-sub">
          This is a public playground with in-memory state. Restore the three seed projects and
          clear the approval inbox and audit trail.
        </p>
        <form method="post" action="/api/demo/reset">
          <button type="submit" class="btn-small">
            Reset demo data
          </button>
        </form>
      </section>
    </article>
  );
}

/** `read` with the app-wide `"observe"` policy — a browser is served, unverified. */
function WhoAmIPanel() {
  const [result, setResult] = useState<string | null>(null);

  return (
    <section class="panel">
      <p class="eyebrow">read &middot; agent.whoami</p>
      <h2>Who does the server think you are?</h2>
      <p class="panel-sub">
        Web Bot Auth policy is <code>"observe"</code>: unsigned callers are served and simply come
        back unverified. A browser has a cookie session, not an RFC 9421 signature.
      </p>
      <button
        type="button"
        class="btn-small"
        onClick={async () => {
          const response = await capabilities.agent.whoami();
          setResult(JSON.stringify(response, null, 2));
        }}
      >
        Call agent.whoami
      </button>
      {result ? <Output>{result}</Output> : null}
    </section>
  );
}

/** `agentPolicy: "require"` — the browser is expected to be rejected here. */
function BriefPanel() {
  const [result, setResult] = useState<string | null>(null);

  return (
    <section class="panel">
      <p class="eyebrow">read &middot; agent.brief &middot; agentPolicy: require</p>
      <h2>The endpoint a browser cannot use</h2>
      <p class="panel-sub">
        This capability overrides the app default and answers only cryptographically verified
        agents. From here you should get a typed{" "}
        <code>
          401 {"{"} code: "agent_required" {"}"}
        </code>
        . Run <code>node scripts/agent.mjs</code> to see the other outcome.
      </p>
      <button
        type="button"
        class="btn-small"
        onClick={async () => {
          const response = await fetch("/api/capabilities/agent/brief", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          setResult(`HTTP ${response.status}\n${JSON.stringify(await response.json(), null, 2)}`);
        }}
      >
        Call agent.brief
      </button>
      {result ? <Output>{result}</Output> : null}
    </section>
  );
}

/** `useCapability` owns pending/error/result so the component does not. */
function SearchPanel() {
  const [query, setQuery] = useState("api");
  const search = useCapability("projects.search");

  return (
    <section class="panel">
      <p class="eyebrow">read &middot; projects.search</p>
      <h2>useCapability()</h2>
      <p class="panel-sub">
        Concurrent calls are last-one-wins, so a stale response can never overwrite a newer one, and
        the previous result stays visible while a follow-up is in flight.
      </p>
      <div class="inline-form">
        <input
          type="text"
          value={query}
          placeholder="Search projects"
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
        <button
          type="button"
          disabled={search.pending}
          onClick={() => void search.call({ query, limit: 5 })}
        >
          {search.pending ? "Searching…" : "Search"}
        </button>
      </div>
      {search.error ? <Output tone="error">{search.error.message}</Output> : null}
      {search.data ? (
        <Output>
          {`${search.data.count} match(es)\n` +
            search.data.projects
              .map(
                (project) => `• ${project.name} — ${project.status} (${project.deploys} deploys)`,
              )
              .join("\n")}
        </Output>
      ) : null}
    </section>
  );
}

function CreatePanel() {
  const [status, setStatus] = useState<string | null>(null);

  return (
    <>
      <Form
        capability="projects.create"
        class="inline-form"
        onCapabilityResult={(result) => {
          setStatus(
            result.ok
              ? `Created "${result.data.project.name}" (id ${result.data.project.id})`
              : `${result.error.code}: ${result.error.message}`,
          );
        }}
      >
        <input name="name" placeholder="Project name" required minLength={2} maxLength={40} />
        <input name="summary" placeholder="Summary" maxLength={160} />
        <button type="submit">Create</button>
      </Form>
      {status ? <Output>{status}</Output> : null}
    </>
  );
}

/**
 * WebMCP is feature-detected: the shim lives in its own chunk and browsers
 * without `document.modelContext` never download it.
 */
function WebMcpStatus() {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const global = window as unknown as {
      document?: { modelContext?: unknown };
      navigator?: { modelContext?: unknown };
    };
    setAvailable(Boolean(global.document?.modelContext) || Boolean(global.navigator?.modelContext));
  }, []);

  return (
    <div class={`webmcp-chip ${available ? "on" : "off"}`}>
      <span class="webmcp-dot" />
      {available === null
        ? "Checking WebMCP…"
        : available
          ? "WebMCP available — page tools registered"
          : "No WebMCP in this browser — shim not downloaded"}
    </div>
  );
}

function Output({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <pre class={`console-output${tone === "error" ? " console-error" : ""}`}>
      <code>{children}</code>
    </pre>
  );
}
