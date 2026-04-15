import { Form, useRevalidate, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

interface Project {
  id: string;
  name: string;
  status: string;
  deploys: number;
}

const PROJECTS: Project[] = [
  { id: "1", name: "Marketing site", status: "live", deploys: 42 },
  { id: "2", name: "API v2", status: "building", deploys: 18 },
  { id: "3", name: "Mobile app", status: "live", deploys: 7 },
];

export async function loader({ request }: LoaderArgs) {
  const cookie = request.headers.get("cookie") ?? "";
  const user = cookie.includes("session=") ? "Ada Lovelace" : "Guest";

  return {
    user,
    projects: PROJECTS,
    totalDeploys: PROJECTS.reduce((sum, p) => sum + p.deploys, 0),
  };
}

export function head({ data }: RouteComponentProps<typeof loader>) {
  return { title: `Dashboard — ${data.user}` };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const revalidate = useRevalidate();

  return (
    <section class="dashboard">
      <h1>Welcome back, {data.user}</h1>
      <p class="dashboard-stat">
        {data.projects.length} projects &middot; {data.totalDeploys} deploys
      </p>

      <div class="project-list">
        {data.projects.map((project) => (
          <a key={project.id} href={`/app/projects/${project.id}`} class="project-card">
            <strong>{project.name}</strong>
            <span class={`status status-${project.status}`}>{project.status}</span>
            <span class="deploys">{project.deploys} deploys</span>
          </a>
        ))}
      </div>

      <Form
        method="post"
        action="/api/projects/refresh"
        onSubmit={async () => {
          await revalidate();
        }}
      >
        <button type="submit">Refresh data</button>
      </Form>
    </section>
  );
}
