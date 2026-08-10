import { notFound, type LoaderArgs, type RouteComponentProps } from "@pracht/core";
import { ArchiveFlow } from "../components/archive-flow.tsx";
import { DeployButton } from "../components/deploy-button.tsx";
import { getProject } from "../server/projects-store.ts";

/**
 * Not every read has to become a capability. This loader talks to the store
 * directly because "render one project page" is not an operation agents need —
 * and auto-generating a tool for every route is exactly the sprawl that
 * measurably hurts agent task completion. What is registered in the manifest is
 * a deliberate, curated list.
 */
export async function loader({ params }: LoaderArgs) {
  const project = getProject(params.projectId);
  if (!project) throw notFound();
  return { project };
}

export function head({ data }: RouteComponentProps<typeof loader>) {
  return { title: `${data.project.name} — Launchpad` };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const { project } = data;

  return (
    <section class="project-detail">
      <header class="page-head">
        <div>
          <p class="eyebrow">{project.environment}</p>
          <h1>{project.name}</h1>
          <p class="page-sub">{project.summary}</p>
        </div>
        <span class={`status status-${project.status}`}>{project.status}</span>
      </header>

      <dl class="detail-grid">
        <div>
          <dt>Deploys</dt>
          <dd>{project.deploys}</dd>
        </div>
        <div>
          <dt>Last deploy</dt>
          <dd>{project.lastDeploy}</dd>
        </div>
        <div>
          <dt>Project id</dt>
          <dd>
            <code>{project.id}</code>
          </dd>
        </div>
      </dl>

      {project.status === "archived" ? (
        <p class="flow-result">This project is archived.</p>
      ) : (
        <>
          <div class="panel">
            <p class="eyebrow">write &middot; projects.deploy</p>
            <h2>Ship it</h2>
            <p class="panel-sub">
              Retry-safe: the call carries an idempotency key and the server absorbs a repeat rather
              than deploying twice.
            </p>
            <DeployButton projectId={project.id} />
          </div>

          <div class="panel panel-danger">
            <p class="eyebrow">destructive &middot; projects.archive</p>
            <h2>Archive {project.name}</h2>
            <p class="panel-sub">
              Prepare mints a token bound to this exact input; a reviewer approves the proposal; the
              commit consumes it once.
            </p>
            <ArchiveFlow projectId={project.id} name={project.name} />
          </div>
        </>
      )}

      <a href="/app" class="back-link">
        &larr; Back to dashboard
      </a>
    </section>
  );
}
