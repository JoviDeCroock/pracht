/**
 * The demo's domain layer. Deliberately boring: an in-memory store so the
 * showcase has no database to provision. Every capability's `run()` calls into
 * this module and nothing else, which is the point — the business logic has one
 * home and the browser, HTTP, WebMCP and (soon) MCP projections all reach it
 * through the same validated pipeline.
 *
 * In-memory state is per server instance. On a serverless deployment that means
 * writes can appear to vanish when a request lands on a cold instance; see the
 * "Deploying this demo" section of the README.
 */

export type ProjectStatus = "live" | "building" | "paused" | "archived";

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  environment: "production" | "preview";
  deploys: number;
  lastDeploy: string;
  summary: string;
}

const SEED: Project[] = [
  {
    id: "atlas",
    name: "Atlas",
    status: "live",
    environment: "production",
    deploys: 42,
    lastDeploy: "2 hours ago",
    summary: "Public marketing site. Static at the edge, revalidated on publish.",
  },
  {
    id: "beacon",
    name: "Beacon",
    status: "building",
    environment: "preview",
    deploys: 18,
    lastDeploy: "12 minutes ago",
    summary: "Customer-facing API. Per-request rendering, personalised dashboards.",
  },
  {
    id: "corvus",
    name: "Corvus",
    status: "paused",
    environment: "preview",
    deploys: 7,
    lastDeploy: "3 days ago",
    summary: "Mobile companion app. Paused while the design system lands.",
  },
];

let projects: Project[] = SEED.map((project) => ({ ...project }));

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "project";
}

export function listProjects(): Project[] {
  return projects.map((project) => ({ ...project }));
}

export function searchProjects(query: string, status: string, limit: number): Project[] {
  const needle = query.trim().toLowerCase();
  return projects
    .filter((project) => (status === "any" ? true : project.status === status))
    .filter(
      (project) =>
        needle === "" ||
        project.name.toLowerCase().includes(needle) ||
        project.summary.toLowerCase().includes(needle),
    )
    .slice(0, limit)
    .map((project) => ({ ...project }));
}

export function getProject(id: string): Project | null {
  const found = projects.find((project) => project.id === id);
  return found ? { ...found } : null;
}

export function createProject(input: {
  name: string;
  summary?: string;
  environment?: "production" | "preview";
}): Project {
  let id = slugify(input.name);
  let suffix = 2;
  while (projects.some((project) => project.id === id)) {
    id = `${slugify(input.name)}-${suffix++}`;
  }

  const project: Project = {
    id,
    name: input.name,
    status: "building",
    environment: input.environment ?? "preview",
    deploys: 0,
    lastDeploy: "never",
    summary: input.summary ?? "No description yet.",
  };
  projects = [...projects, project];
  return { ...project };
}

/**
 * `write` effects have no framework idempotency helper, so the input schema
 * carries an optional `idempotencyKey` and the store dedupes on it — the
 * pattern docs/AGENT_TRUST.md prescribes for retrying agents.
 */
const deployKeys = new Map<string, number>();

export function deployProject(
  id: string,
  idempotencyKey?: string,
): { project: Project; deduped: boolean } | null {
  const index = projects.findIndex((project) => project.id === id);
  if (index === -1) return null;

  if (idempotencyKey) {
    const key = `${id}:${idempotencyKey}`;
    const seen = deployKeys.get(key);
    if (seen !== undefined) {
      return { project: { ...projects[index] }, deduped: true };
    }
    deployKeys.set(key, Date.now());
  }

  const updated: Project = {
    ...projects[index],
    status: "live",
    deploys: projects[index].deploys + 1,
    lastDeploy: "just now",
  };
  projects = projects.map((project, i) => (i === index ? updated : project));
  return { project: { ...updated }, deduped: false };
}

export function archiveProject(id: string): Project | null {
  const index = projects.findIndex((project) => project.id === id);
  if (index === -1) return null;
  const updated: Project = { ...projects[index], status: "archived" };
  projects = projects.map((project, i) => (i === index ? updated : project));
  return { ...updated };
}

export function resetProjects(): void {
  projects = SEED.map((project) => ({ ...project }));
  deployKeys.clear();
}
