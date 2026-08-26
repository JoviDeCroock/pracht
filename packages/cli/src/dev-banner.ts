import type { AppGraphCapability } from "@pracht/core";

import type { AppGraphApiRoute, AppGraphRoute } from "./app-graph.js";

export interface DevBannerRoute extends Pick<
  AppGraphRoute,
  "middleware" | "path" | "render" | "shell"
> {
  // Optional: only set when a route opts out of the default full hydration.
  hydration?: AppGraphRoute["hydration"];
}

export interface DevBannerApiRoute extends Pick<AppGraphApiRoute, "methods" | "path"> {}

export interface DevBannerCapability extends Pick<
  AppGraphCapability,
  "effect" | "error" | "httpPath" | "name" | "transports"
> {}

export interface DevBannerOptions {
  apiRoutes: DevBannerApiRoute[];
  capabilities?: DevBannerCapability[];
  color?: boolean;
  localUrls: string[];
  /** Path the remote MCP projection is served from, `null` when unconfigured. */
  mcpEndpoint?: string | null;
  /** `agents.mcp.destructive` — without it the endpoint filters destructive tools out. */
  mcpDestructive?: boolean;
  /** Runtime preconditions that currently block the configured MCP endpoint. */
  mcpUnavailableReasons?: string[];
  networkUrls?: string[];
  notFound?: DevBannerRoute | null;
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
    mcpDestructive = false,
    mcpEndpoint = null,
    mcpUnavailableReasons = [],
    networkUrls = [],
    notFound,
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
  if (routes.length === 0 && !notFound) {
    lines.push("    (none)");
  } else {
    // The not-found page is listed after the routes it can never shadow: its
    // "path" is a label, not a pattern, so it is excluded from the count.
    const allRoutes = [...routes, ...(notFound ? [notFound] : [])];
    // Only worth a column when some route actually opts out of full hydration:
    // otherwise `/islands` and `/static` are indistinguishable from every other
    // route in the table that tells you what runs where.
    const showHydration = allRoutes.some((route) => route.hydration && route.hydration !== "full");
    const rows = allRoutes.map((route) => [
      route.path,
      route.render ?? "ssr",
      ...(showHydration ? [route.hydration ?? "full"] : []),
      route.shell ?? "-",
      route.middleware.length > 0 ? route.middleware.join(", ") : "-",
    ]);
    const header = [
      "ROUTE",
      "MODE",
      ...(showHydration ? ["HYDRATION"] : []),
      "SHELL",
      "MIDDLEWARE",
    ];
    const widths = columnWidths([header, ...rows]);
    lines.push(`    ${paint(formatRow(header, widths), ANSI.dim)}`);
    for (const row of rows) {
      const cells = row.map((cell, index) => {
        const padded = index === row.length - 1 ? cell : cell.padEnd(widths[index]);
        return index === 1 ? paint(padded, MODE_COLORS[cell] ?? ANSI.dim) : padded;
      });
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

  // Apps without capabilities skip the section unless an MCP endpoint is
  // configured. The endpoint remains active even when the graph is empty.
  if (capabilities.length > 0 || mcpEndpoint) {
    const heading = `Capabilities (${capabilities.length})`;
    lines.push(
      mcpEndpoint
        ? `  ${paint(heading, ANSI.bold)}  ${paint(`MCP endpoint ${mcpEndpoint}`, ANSI.dim)}`
        : `  ${paint(heading, ANSI.bold)}`,
    );
    if (capabilities.length === 0) {
      lines.push("    (none)");
    } else {
      const unreadable = capabilities.filter((capability) => capability.error);
      const rows = capabilities.map((capability) => [
        capability.name,
        capability.effect ?? "?",
        capability.transports.length > 0
          ? capability.transports
              // `expose.mcp` is only served when the app configures
              // `agents.mcp`, and a destructive capability additionally needs
              // `agents.mcp.destructive` — don't let the banner imply either.
              .map((transport) =>
                transport === "mcp" &&
                (!mcpEndpoint ||
                  mcpUnavailableReasons.length > 0 ||
                  (capability.effect === "destructive" && !mcpDestructive))
                  ? "mcp(unserved)"
                  : transport,
              )
              .join(",")
          : "private",
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

      // Effect and exposure above were recovered by static analysis; the
      // schemas were not. Without this the row reads as a complete contract.
      for (const capability of unreadable) {
        lines.push(
          `    ${paint(`! ${capability.name} could not be loaded: ${capability.error}`, ANSI.red)}`,
        );
      }
      if (mcpUnavailableReasons.length > 0) {
        lines.push(
          `    ${paint(`! MCP endpoint unavailable: ${mcpUnavailableReasons.join(" ")}`, ANSI.red)}`,
        );
      }
      if (unreadable.length > 0) {
        lines.push(
          `    ${paint("  Effect, exposure, policy and middleware above were recovered from the source; output schemas are unavailable, so `pracht typegen` types them as `unknown`. If the module imports `@pracht/capabilities`, install it.", ANSI.dim)}`,
        );
      }
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
