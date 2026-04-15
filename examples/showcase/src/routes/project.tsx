import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

interface ProjectData {
  name: string;
  status: string;
  deploys: number;
  lastDeploy: string;
}

const PROJECTS: Record<string, ProjectData> = {
  "1": { name: "Marketing site", status: "live", deploys: 42, lastDeploy: "2 hours ago" },
  "2": { name: "API v2", status: "building", deploys: 18, lastDeploy: "12 minutes ago" },
  "3": { name: "Mobile app", status: "live", deploys: 7, lastDeploy: "3 days ago" },
};

export async function loader({ params }: LoaderArgs) {
  const project = PROJECTS[params.projectId];
  if (!project) throw new Error("Project not found");
  return { id: params.projectId, ...project };
}

export function head({ data }: RouteComponentProps<typeof loader>) {
  return { title: `${data.name} — Launchpad` };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="project-detail">
      <h1>{data.name}</h1>
      <dl>
        <dt>Status</dt>
        <dd>
          <span class={`status status-${data.status}`}>{data.status}</span>
        </dd>
        <dt>Total deploys</dt>
        <dd>{data.deploys}</dd>
        <dt>Last deploy</dt>
        <dd>{data.lastDeploy}</dd>
      </dl>
      <a href="/app" class="back-link">
        &larr; Back to dashboard
      </a>
    </section>
  );
}
