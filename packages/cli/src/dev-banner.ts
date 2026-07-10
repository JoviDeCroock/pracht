import type { AppGraphCapability } from "@pracht/core";

import type { AppGraphApiRoute, AppGraphRoute } from "./app-graph.js";

export interface DevBannerRoute extends Pick<
  AppGraphRoute,
  "middleware" | "path" | "render" | "shell"
> {}

export interface DevBannerApiRoute extends Pick<AppGraphApiRoute, "methods" | "path"> {}

export interface DevBannerCapability extends Pick<
  AppGraphCapability,
  "effect" | "httpPath" | "name" | "transports"
> {}

export interface DevBannerOptions {
  apiRoutes: DevBannerApiRoute[];
  capabilities?: DevBannerCapability[];
  color?: boolean;
  localUrls: string[];
  networkUrls?: string[];
  routes: DevBannerRoute[];
}

const ANSI = {
  bold: "1",
  cyan: "36",
  dim: "2",
  green: "32",
  magenta: "35",
  red: "31",
  yellow: "33",
};

const MODE_COLORS: Record<string, string> = {
  isg: ANSI.cyan,
  spa: ANSI.magenta,
  ssg: ANSI.green,
  ssr: ANSI.yellow,
};

const EFFECT_COLORS: Record<string, string> = {
  destructive: ANSI.red,
  read: ANSI.green,
  write: ANSI.yellow,
};

/**
 * Format the `pracht dev` startup banner: local URL(s) plus an aligned table
 * of page routes (pattern, render mode, shell, middleware) and API routes.
 */
export function formatDevBanner(options: DevBannerOptions): string {
  const {
    apiRoutes,
    capabilities = [],
    color = false,
    localUrls,
    networkUrls = [],
    routes,
  } = options;
  const paint = (text: string, code: string): string =>
    color ? `\u001b[${code}m${text}\u001b[0m` : text;

  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${paint("pracht dev", ANSI.bold)}`);
  lines.push("");

  for (const url of localUrls) {
    lines.push(`  ${paint("➜", ANSI.green)}  Local:   ${paint(url, `${ANSI.bold};${ANSI.cyan}`)}`);
  }
  for (const url of networkUrls) {
    lines.push(`  ${paint("➜", ANSI.green)}  Network: ${paint(url, ANSI.cyan)}`);
  }
  lines.push("");

  lines.push(`  ${paint(`Routes (${routes.length})`, ANSI.bold)}`);
  if (routes.length === 0) {
    lines.push("    (none)");
  } else {
    const rows = routes.map((route) => [
      route.path,
      route.render ?? "ssr",
      route.shell ?? "-",
      route.middleware.length > 0 ? route.middleware.join(", ") : "-",
    ]);
    const header = ["ROUTE", "MODE", "SHELL", "MIDDLEWARE"];
    const widths = columnWidths([header, ...rows]);
    lines.push(`    ${paint(formatRow(header, widths), ANSI.dim)}`);
    for (const row of rows) {
      const [path, mode, shell, middleware] = row;
      const cells = [
        path.padEnd(widths[0]),
        paint(mode.padEnd(widths[1]), MODE_COLORS[mode] ?? ANSI.dim),
        shell.padEnd(widths[2]),
        middleware,
      ];
      lines.push(`    ${cells.join("  ")}`.trimEnd());
    }
  }
  lines.push("");

  lines.push(`  ${paint(`API (${apiRoutes.length})`, ANSI.bold)}`);
  if (apiRoutes.length === 0) {
    lines.push("    (none)");
  } else {
    const rows = apiRoutes.map((route) => [
      route.path,
      route.methods.length > 0 ? route.methods.join(", ") : "-",
    ]);
    const header = ["ROUTE", "METHODS"];
    const widths = columnWidths([header, ...rows]);
    lines.push(`    ${paint(formatRow(header, widths), ANSI.dim)}`);
    for (const row of rows) {
      lines.push(`    ${formatRow(row, widths)}`);
    }
  }
  lines.push("");

  // Apps without capabilities skip the section entirely — most apps don't
  // register any, and an empty table would only add noise.
  if (capabilities.length > 0) {
    lines.push(`  ${paint(`Capabilities (${capabilities.length})`, ANSI.bold)}`);
    const rows = capabilities.map((capability) => [
      capability.name,
      capability.effect ?? "?",
      capability.transports.length > 0 ? capability.transports.join(",") : "private",
      capability.httpPath ?? "-",
    ]);
    const header = ["NAME", "EFFECT", "EXPOSURE", "HTTP"];
    const widths = columnWidths([header, ...rows]);
    lines.push(`    ${paint(formatRow(header, widths), ANSI.dim)}`);
    for (const row of rows) {
      const [name, effect, exposure, httpPath] = row;
      const cells = [
        name.padEnd(widths[0]),
        paint(effect.padEnd(widths[1]), EFFECT_COLORS[effect] ?? ANSI.dim),
        exposure.padEnd(widths[2]),
        httpPath,
      ];
      lines.push(`    ${cells.join("  ")}`.trimEnd());
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Respect NO_COLOR (https://no-color.org) and only color TTY output. */
export function supportsColor(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.NO_COLOR) {
    return false;
  }
  if (env.FORCE_COLOR) {
    return true;
  }
  return isTTY;
}

function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return widths;
}

function formatRow(cells: string[], widths: number[]): string {
  return cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index])))
    .join("  ")
    .trimEnd();
}
