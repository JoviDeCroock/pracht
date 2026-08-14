import type { ProjectConfig } from "./project.js";

const ADAPTER_TARGETS = new Set(["cloudflare", "netlify", "node", "vercel"]);

export type AdapterTarget = "cloudflare" | "netlify" | "node" | "vercel";

export function detectAdapterTarget(project: Pick<ProjectConfig, "rawConfig">): AdapterTarget {
  const source = project.rawConfig;

  if (/\bcloudflareAdapter\s*\(/.test(source) || source.includes("@pracht/adapter-cloudflare")) {
    return "cloudflare";
  }

  if (/\bvercelAdapter\s*\(/.test(source) || source.includes("@pracht/adapter-vercel")) {
    return "vercel";
  }

  if (/\bnetlifyAdapter\s*\(/.test(source) || source.includes("@pracht/adapter-netlify")) {
    return "netlify";
  }

  return "node";
}

export function normalizeAdapterTarget(value: unknown): AdapterTarget | null {
  return typeof value === "string" && ADAPTER_TARGETS.has(value) ? (value as AdapterTarget) : null;
}
