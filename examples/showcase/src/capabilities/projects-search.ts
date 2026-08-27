import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import "../server/agent-runtime.ts";
import { searchProjects } from "../server/projects-store.ts";

interface SearchInput {
  query: string;
  status: "any" | "live" | "building" | "paused" | "archived";
  limit: number;
}

/**
 * The read capability every surface uses:
 *
 *   /playground      → `useCapability("projects.search")` in the browser
 *   /app             → `invokeCapability()` in the SSR loader
 *   an HTTP agent    → POST /api/capabilities/projects/search
 *   Gemini in Chrome → the same tool, registered on the page via WebMCP
 *   a remote agent   → the `projects_search` tool at POST /mcp
 *
 * One contract, five callers, no duplicated business rules.
 */
export default defineCapability({
  title: "Search projects",
  description:
    "Find Launchpad projects by name or summary. Returns id, name, status, environment and deploy count.",
  input: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 120,
        default: "",
        description: "Free text matched against project name and summary. Empty matches all.",
      },
      status: {
        type: "string",
        enum: ["any", "live", "building", "paused", "archived"],
        default: "any",
        description: "Restrict results to one lifecycle status.",
      },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    },
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      projects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            status: { type: "string" },
            environment: { type: "string" },
            deploys: { type: "integer" },
            lastDeploy: { type: "string" },
            summary: { type: "string" },
          },
          required: ["id", "name", "status", "environment", "deploys", "lastDeploy", "summary"],
        },
      },
      count: { type: "integer" },
    },
    required: ["projects", "count"],
  },
  effect: "read",
  expose: {
    http: true,
    // Project names and summaries are user-authored, so the page tool
    // advertises untrustedContentHint to WebMCP hosts.
    webmcp: { untrustedContent: true },
    // Served at /mcp as the `projects_search` tool because the manifest also
    // configures `agents.mcp`. Without that block this would be recorded in
    // the graph and reported as `mcp(unserved)` rather than looking live.
    mcp: true,
  },
  async run({ input }: CapabilityRunArgs<SearchInput>) {
    const projects = searchProjects(input.query, input.status, input.limit);
    return { projects, count: projects.length };
  },
});
