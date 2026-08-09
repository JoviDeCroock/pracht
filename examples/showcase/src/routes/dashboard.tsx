import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";
import { invokeCapability } from "@pracht/core/server";
import { useState } from "preact/hooks";
import { ArchiveFlow } from "../components/archive-flow.tsx";
import { DeployButton } from "../components/deploy-button.tsx";
import { readSession } from "../server/session.ts";

/**
 * SSR. The loader calls the *same* capability an agent calls — through the same
 * validation and middleware pipeline — instead of reaching into the store. The
 * page and the tool cannot drift, because there is only one implementation.
 */
export async function loader({ request, context, signal }: LoaderArgs) {
  const user = readSession(request);
  const result = await invokeCapability(
    "projects.search",
    { limit: 20 },
    { request, context, signal },
  );

  return {
    user: user?.name ?? "Guest",
    projects: result.ok ? result.data.projects : [],
    error: result.ok ? null : result.error.message,
  };
}

export function head({ data }: RouteComponentProps<typeof loader>) {
  return { title: `Dashboard — ${data.user}` };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const [created, setCreated] = useState<string | null>(null);
  const active = data.projects.filter((project) => project.status !== "archived");
  const deploys = data.projects.reduce((sum, project) => sum + project.deploys, 0);

  return (
    <section class="dashboard">
      <header class="page-head">
        <div>
          <p class="eyebrow">Server-rendered per request</p>
          <h1>Welcome back, {data.user}</h1>
          <p class="page-sub">
            {active.length} active {active.length === 1 ? "project" : "projects"} &middot; {deploys}{" "}
            deploys. This list came from <code>invokeCapability("projects.search")</code> in the
            loader.
          </p>
        </div>
      </header>

      {data.error ? <p class="flow-result flow-error">{data.error}</p> : null}

      <div class="project-list">
        {data.projects.map((project) => (
          <article key={project.id} class="project-card">
            <div class="project-card-head">
              <a href={`/app/projects/${project.id}`}>
                <strong>{project.name}</strong>
              </a>
              <span class={`status status-${project.status}`}>{project.status}</span>
            </div>
            <p class="project-summary">{project.summary}</p>
            <div class="project-card-foot">
              <span class="deploys">
                {project.deploys} deploys &middot; {project.lastDeploy}
              </span>
              {project.status === "archived" ? null : <DeployButton projectId={project.id} />}
            </div>
          </article>
        ))}
      </div>

      <div class="panel">
        <p class="eyebrow">write &middot; projects.create</p>
        <h2>One contract, two audiences</h2>
        <p class="panel-sub">
          This form posts to the exact endpoint an agent calls. Fields are coerced onto the
          capability's input schema server-side, and without JavaScript the endpoint accepts the
          form-encoded post and redirects back here.
        </p>
        <Form
          capability="projects.create"
          class="inline-form"
          onCapabilityResult={(result) => {
            setCreated(
              result.ok
                ? `Created "${result.data.project.name}"`
                : `${result.error.code}: ${result.error.message}`,
            );
          }}
        >
          <input name="name" placeholder="Project name" required minLength={2} maxLength={40} />
          <input name="summary" placeholder="One line summary" maxLength={160} />
          <select name="environment">
            <option value="preview">preview</option>
            <option value="production">production</option>
          </select>
          <button type="submit">Create project</button>
        </Form>
        {created ? <p class="flow-result">{created}</p> : null}
      </div>

      <div class="panel panel-danger">
        <p class="eyebrow">destructive &middot; projects.archive</p>
        <h2>Archiving needs a person</h2>
        <p class="panel-sub">
          Two round trips and a human decision. The caller is handed a token bound to the exact
          input; a reviewer approves the proposal in the <a href="/app/approvals">approval inbox</a>
          ; only then does the commit run — exactly once.
        </p>
        {active.length === 0 ? (
          <p class="panel-sub">Everything is archived. Reset the demo from the playground.</p>
        ) : (
          active.map((project) => (
            <div key={project.id} class="archive-row">
              <span class="archive-row-name">{project.name}</span>
              <ArchiveFlow projectId={project.id} name={project.name} />
            </div>
          ))
        )}
      </div>
    </section>
  );
}
