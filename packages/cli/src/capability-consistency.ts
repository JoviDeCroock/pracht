/**
 * Cross-check the two ways pracht reads a capability's exposure.
 *
 * `pracht typegen` gets its metadata from the resolved app graph, which loads
 * capability modules and reads the objects `defineCapability()` returned. The
 * Vite plugin cannot do that — capability modules are server-only and must
 * never enter the client graph — so it builds the browser endpoint table from
 * static analysis of the same sources instead.
 *
 * Both feed the type layer: the graph decides what `Register["capabilities"]`
 * marks as http-exposed, and the static pass decides which endpoints the
 * generated client actually dispatches. If they disagreed, the generated types
 * would promise a capability the browser bundle has no endpoint for — a
 * compile-time green light for a call that 404s. Typegen is the moment those
 * types are minted, so it is the right place to prove the two agree.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  extractCapabilityProjection,
  type CapabilityProjection,
} from "@pracht/capabilities/static";

import { resolveProjectPath, type ProjectConfig } from "./project.js";

/** The subset of the app-graph capability entry this check compares. */
export interface GraphCapabilityExposure {
  effect: string | null;
  httpPath: string | null;
  name: string;
  source: string;
  transports: string[];
}

/**
 * Throw when the executed graph and the static analyzer disagree about a
 * capability's HTTP path, effect class, or WebMCP exposure — including when
 * static analysis cannot read an exposed capability at all, which is the most
 * common way the two diverge (a computed `expose`, a hoisted constant).
 *
 * Capabilities whose source file is missing are skipped: the manifest check
 * reports those, and duplicating it here would turn one problem into two.
 */
export function assertCapabilityProjectionsAgree(
  project: ProjectConfig,
  capabilities: GraphCapabilityExposure[],
): void {
  if (capabilities.length === 0) return;

  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return;
  const manifestDir = dirname(manifestPath);

  const drift: string[] = [];
  for (const capability of capabilities) {
    // Root-relative refs resolve against the project root, matching the runtime
    // registry and the Vite plugin; everything else is manifest-relative.
    const filePath = capability.source.startsWith("/")
      ? resolveProjectPath(project.root, capability.source)
      : resolve(manifestDir, capability.source);
    if (!existsSync(filePath)) continue;

    // serializeCapabilities() uses a null effect to retain a graph entry when
    // its module failed to load. That is a wiring failure for verify/doctor to
    // report, not projection drift; comparing its other null fallback fields
    // against valid source text would hide the real cause behind an unrelated
    // instruction to inline expose/effect.
    if (capability.effect === null) continue;

    let projection: CapabilityProjection;
    try {
      projection = extractCapabilityProjection(
        capability.name,
        readFileSync(filePath, "utf-8"),
        (detail) => detail,
      );
    } catch (error) {
      // Extraction failing *is* the drift, not a reason to skip: the graph read
      // this capability by executing it, the client projection could not read
      // it at all, and the emitted types would describe an endpoint the browser
      // bundle never registers. Only report it for capabilities the graph
      // believes are exposed — a private one has no client projection to differ
      // from, and the build raises its own error for genuinely broken sources.
      if (capability.httpPath !== null || capability.transports.length > 0) {
        drift.push(
          `  ${capability.name} (${capability.source}): the app graph exposes it over ` +
            `${describe(capability.httpPath)}, but static analysis cannot read its projection — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    for (const difference of compare(capability, projection)) {
      drift.push(`  ${capability.name} (${capability.source}): ${difference}`);
    }
  }

  if (drift.length > 0) {
    throw new Error(
      "Capability exposure differs between the resolved app graph and build-time static " +
        "analysis, so generated types would not match the endpoints the browser bundle " +
        `registers:\n${drift.join("\n")}\n` +
        "This happens when `expose` or `effect` is computed rather than written as an inline " +
        "literal. Declare them inline so both readers see the same contract.",
    );
  }
}

function compare(graph: GraphCapabilityExposure, statically: CapabilityProjection): string[] {
  const differences: string[] = [];

  if (graph.httpPath !== statically.httpPath) {
    differences.push(
      `HTTP endpoint is ${describe(graph.httpPath)} in the app graph but ` +
        `${describe(statically.httpPath)} in static analysis`,
    );
  }

  // Effect only matters where it is projected. The static pass reads it only
  // for http-exposed capabilities (a private one has no client projection to
  // annotate), so comparing it elsewhere would report drift that cannot exist.
  // A null graph effect means the module failed to load — a broken
  // registration other checks already report, not exposure drift.
  if (statically.httpPath !== null && graph.effect !== null && graph.effect !== statically.effect) {
    differences.push(
      `effect is ${describe(graph.effect)} in the app graph but ` +
        `${describe(statically.effect)} in static analysis`,
    );
  }

  const graphWebmcp = graph.transports.includes("webmcp");
  if (graphWebmcp !== statically.webmcp) {
    differences.push(
      `WebMCP exposure is ${graphWebmcp ? "on" : "off"} in the app graph but ` +
        `${statically.webmcp ? "on" : "off"} in static analysis`,
    );
  }

  return differences;
}

function describe(value: string | null): string {
  return value === null ? "none" : JSON.stringify(value);
}
