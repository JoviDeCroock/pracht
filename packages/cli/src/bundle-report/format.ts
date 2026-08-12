import { formatBytes } from "./size.js";
import type { BudgetEvaluation, BundleReport, FormatOptions } from "./types.js";

export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function formatBundleReport(report: BundleReport, options: FormatOptions = {}): string {
  const color = options.color ?? false;
  const rows: { label: string; raw: string; gzip: string; kind: "chunk" | "total" | "header" }[] =
    [];

  for (const route of report.routes) {
    const modeSuffix = route.hydration && route.hydration !== "full" ? `, ${route.hydration}` : "";
    rows.push({
      label: `${route.path} (${route.render}${modeSuffix})`,
      raw: "",
      gzip: "",
      kind: "header",
    });
    for (const chunk of route.chunks) {
      rows.push({
        label: `  ${chunk.url}`,
        raw: formatBytes(chunk.bytes),
        gzip: formatBytes(chunk.gzipBytes),
        kind: "chunk",
      });
    }
    const totalLabel =
      route.hydration === "islands"
        ? "  total (islands bootstrap + islands, no shared entry)"
        : route.hydration === "none"
          ? "  total (no client js)"
          : "  total (incl. shared)";
    rows.push({
      label: totalLabel,
      raw: formatBytes(route.totalBytes),
      gzip: formatBytes(route.totalGzipBytes),
      kind: "total",
    });
  }

  rows.push({ label: "shared entry (all routes)", raw: "", gzip: "", kind: "header" });
  for (const chunk of report.shared.chunks) {
    rows.push({
      label: `  ${chunk.url}`,
      raw: formatBytes(chunk.bytes),
      gzip: formatBytes(chunk.gzipBytes),
      kind: "chunk",
    });
  }
  rows.push({
    label: "  total",
    raw: formatBytes(report.shared.bytes),
    gzip: formatBytes(report.shared.gzipBytes),
    kind: "total",
  });

  const labelWidth = Math.max("Route / chunk".length, ...rows.map((row) => row.label.length));
  const gzipWidth = Math.max("Gzip".length, ...rows.map((row) => row.gzip.length));
  const rawWidth = Math.max("Raw".length, ...rows.map((row) => row.raw.length));

  const lines: string[] = [];
  lines.push(
    paint(
      `${"Route / chunk".padEnd(labelWidth)}  ${"Gzip".padStart(gzipWidth)}  ${"Raw".padStart(rawWidth)}`,
      "1",
      color,
    ),
  );

  for (const row of rows) {
    const line = `${row.label.padEnd(labelWidth)}  ${row.gzip.padStart(gzipWidth)}  ${row.raw.padStart(rawWidth)}`;
    if (row.kind === "header") {
      lines.push(paint(line.trimEnd(), "1", color));
    } else if (row.kind === "total") {
      lines.push(paint(line, "36", color));
    } else {
      lines.push(paint(line, "2", color));
    }
  }

  return lines.join("\n");
}

export function formatBudgetResults(
  evaluation: BudgetEvaluation,
  options: FormatOptions = {},
): string {
  const color = options.color ?? false;
  const lines: string[] = [paint("Budgets (gzip client JS)", "1", color)];

  const pathWidth = Math.max(...evaluation.results.map((result) => result.path.length), 0);
  for (const result of evaluation.results) {
    const status = result.ok ? paint("PASS", "32", color) : paint("FAIL", "31", color);
    const comparison = result.ok ? "<=" : ">";
    const suffix = result.source === "*" ? " (*)" : "";
    lines.push(
      `${status}  ${result.path.padEnd(pathWidth)}  ${formatBytes(result.gzipBytes)} ${comparison} ${formatBytes(result.limitBytes)}${suffix}`,
    );
  }

  for (const key of evaluation.unmatched) {
    lines.push(
      paint(`WARN  budget for ${JSON.stringify(key)} does not match any route.`, "33", color),
    );
  }

  return lines.join("\n");
}
