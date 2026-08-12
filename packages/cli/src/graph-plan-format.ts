/** Human-readable app-graph plan formatting and build-budget annotations. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AppGraphRoute, RouteConstraint } from "@pracht/core";

import { formatBytes } from "./bundle-report.js";
import type { CapabilityChange, FieldChange, GraphDiff } from "./graph-snapshot.js";

export interface RouteBudgetInfo {
  gzipBytes: number;
  limitBytes: number;
  ok: boolean;
}

/** Per-route gzip sizes from the last `pracht build`, when budgets are configured. */
export function readRouteBudgets(root: string): Map<string, RouteBudgetInfo> {
  const budgets = new Map<string, RouteBudgetInfo>();
  const reportPath = resolve(root, "dist/server/budget-report.json");
  if (!existsSync(reportPath)) return budgets;

  try {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    for (const result of report.results ?? []) {
      budgets.set(result.path, {
        gzipBytes: result.gzipBytes,
        limitBytes: result.limitBytes,
        ok: result.ok,
      });
    }
  } catch {
    // A malformed report only disables size annotations.
  }
  return budgets;
}

export interface FormatPlanOptions {
  base: string | null;
  budgets?: Map<string, RouteBudgetInfo>;
}

export function formatPlanLines(diff: GraphDiff, options: FormatPlanOptions): string[] {
  const budgets = options.budgets ?? new Map();
  const lines: string[] = [];

  for (const route of diff.addedRoutes) {
    lines.push(
      `+ route ${route.path}  ${describeRoute(route)}${budgetSuffix(budgets, route.path)}`,
    );
  }
  for (const entry of diff.changedRoutes) {
    lines.push(
      `~ route ${entry.path}  ${entry.changes.map(formatFieldChange).join(", ")}${budgetSuffix(budgets, entry.path)}`,
    );
  }
  for (const route of diff.removedRoutes) {
    lines.push(`- route ${route.path}`);
  }
  for (const api of diff.addedApi) {
    lines.push(`+ api   ${api.path}  methods=[${api.methods.join(", ")}]`);
  }
  for (const entry of diff.changedApi) {
    lines.push(`~ api   ${entry.path}  ${entry.changes.map(formatFieldChange).join(", ")}`);
  }
  for (const api of diff.removedApi) {
    lines.push(`- api   ${api.path}`);
  }
  if (diff.mcpEndpointChange) {
    lines.push(formatMcpEndpointChange(diff.mcpEndpointChange));
  }
  for (const change of diff.capabilityChanges) {
    lines.push(
      `${capabilityChangeMarker(change)} capability ${change.capability}  ${change.detail}`,
    );
  }
  for (const constraint of diff.addedConstraints) {
    lines.push(`+ constraint ${describeConstraint(constraint)}`);
  }
  for (const constraint of diff.removedConstraints) {
    lines.push(`- constraint ${describeConstraint(constraint)}`);
  }

  return lines;
}

/**
 * Diff-block prefix. `!` marks a widening so it reads as a warning in the
 * rendered diff rather than blending into ordinary additions.
 */
function capabilityChangeMarker(change: CapabilityChange): string {
  if (change.severity === "warn") return "!";
  if (change.kind === "added") return "+";
  if (change.kind === "removed") return "-";
  return "~";
}

function formatMcpEndpointChange(change: FieldChange): string {
  const from = typeof change.from === "string" ? change.from : null;
  const to = typeof change.to === "string" ? change.to : null;
  if (!from && to) {
    return `! mcp endpoint ${to} enabled — declared MCP capabilities are now reachable by agents`;
  }
  if (from && !to) return `- mcp endpoint ${from} disabled`;
  return `~ mcp endpoint ${from} → ${to}`;
}

export function formatPlanText(diff: GraphDiff, options: FormatPlanOptions): string {
  const header = options.base
    ? `Pracht plan (base: ${options.base})`
    : "Pracht plan (no baseline snapshot — every entry shows as added)";
  const lines = formatPlanLines(diff, options);

  if (diff.identical) {
    return `${header}\n\nNo app graph changes.`;
  }
  const footer = diff.widensAgentSurface
    ? "\n\nThis change widens what agents can reach or weakens a guard (! lines)."
    : "";
  return `${header}\n\n${lines.join("\n")}${footer}`;
}

export function formatPlanMarkdown(diff: GraphDiff, options: FormatPlanOptions): string {
  const heading = options.base
    ? `### App graph changes (base: \`${options.base}\`)`
    : "### App graph (no baseline snapshot at the base ref)";

  if (diff.identical) {
    return `${heading}\n\nNo app graph changes.`;
  }

  const lines = formatPlanLines(diff, options);
  const summary = [
    countLabel(diff.addedRoutes.length + diff.addedApi.length, "added"),
    countLabel(diff.changedRoutes.length + diff.changedApi.length, "changed"),
    countLabel(diff.removedRoutes.length + diff.removedApi.length, "removed"),
    countLabel(diff.mcpEndpointChange ? 1 : 0, "MCP endpoint change"),
    countLabel(diff.capabilityChanges.length, "capability change"),
  ]
    .filter(Boolean)
    .join(", ");
  // The one thing in a plan that is a security decision rather than a
  // structural one, so it goes above the diff instead of inside it.
  const warning = diff.widensAgentSurface
    ? "> ⚠️ **This change widens what agents can reach or weakens a guard.**"
    : "";

  return [heading, "", summary ? `${summary}.` : "", warning, "```diff", ...lines, "```"]
    .filter((line, index) => line !== "" || index === 1)
    .join("\n");
}

function describeRoute(route: AppGraphRoute): string {
  const parts = [`render=${route.render ?? "default"}`];
  if (route.hydration) parts.push(`hydration=${route.hydration}`);
  parts.push(`shell=${route.shell ?? "none"}`);
  parts.push(`middleware=[${route.middleware.join(", ")}]`);
  if (route.markdown) parts.push("markdown=true");
  if (route.loaderFile) parts.push(`loader=${route.loaderFile}`);
  if (route.revalidate) parts.push(`revalidate=${JSON.stringify(route.revalidate)}`);
  return parts.join("  ");
}

function describeConstraint(constraint: RouteConstraint): string {
  const { kind, pattern, ...rest } = constraint as RouteConstraint & Record<string, unknown>;
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return `${kind} ${pattern}${detail ? `  ${detail}` : ""}`;
}

function formatFieldChange(change: FieldChange): string {
  return `${change.field}: ${formatValue(change.from)} → ${formatValue(change.to)}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return `[${value.map((entry) => String(entry)).join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function budgetSuffix(budgets: Map<string, RouteBudgetInfo>, path: string): string {
  const budget = budgets.get(path);
  if (!budget) return "";
  const status = budget.ok ? "" : " ⚠ over budget";
  return `  (${formatBytes(budget.gzipBytes)} gz / ${formatBytes(budget.limitBytes)} limit${status})`;
}

function countLabel(count: number, label: string): string {
  return count > 0 ? `${count} ${label}` : "";
}
