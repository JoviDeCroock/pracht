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
  capabilityDescriptorFromGraph,
  diffCapabilityDescriptors,
  extractCapabilityDescriptor,
  type CapabilityDescriptor,
} from "@pracht/capabilities/static";

import { resolveProjectPath, type ProjectConfig } from "./project.js";

/**
 * The app-graph capability entry this check compares. Contract fields the
 * entry omits are unknown and never reported as drift.
 */
export interface GraphCapabilityExposure {
  agentPolicy?: string | null;
  description?: string | null;
  effect: string | null;
  /** Set when the module could not be executed; see the skip below. */
  error?: string | null;
  httpPath: string | null;
  mcpScopes?: string[];
  middleware?: string[];
  name: string;
  source: string;
  title?: string | null;
  transports: string[];
  unverifiedContract?: true;
}

/**
 * Throw when the executed graph and the static analyzer disagree about any
 * field of a capability's descriptor — HTTP path, effect class, MCP exposure
 * and scopes, WebMCP exposure, agent policy, middleware, title, description —
 * including when static analysis cannot read an exposed capability at all,
 * which is the most common way the two diverge (a computed `expose`, a
 * hoisted constant). The comparison is `diffCapabilityDescriptors()`, which
 * walks every key, so a new descriptor field is checked the day it lands.
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

    // A capability whose module failed to load is a wiring failure for
    // verify/doctor to report, not projection drift — and its metadata now
    // comes from this very extractor, so comparing it against the source would
    // only ever compare the extractor with itself.
    if (capability.error != null) continue;

    let statically: CapabilityDescriptor;
    try {
      statically = extractCapabilityDescriptor(
        capability.name,
        readFileSync(filePath, "utf-8"),
        (detail) => detail,
      ).descriptor;
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

    for (const difference of diffCapabilityDescriptors(
      capabilityDescriptorFromGraph(capability),
      statically,
      { a: "the app graph", b: "static analysis" },
    )) {
      drift.push(`  ${capability.name} (${capability.source}): ${difference}`);
    }
  }

  if (drift.length > 0) {
    throw new Error(
      "Capability exposure differs between the resolved app graph and build-time static " +
        "analysis, so generated types would not match the endpoints the browser bundle " +
        `registers:\n${drift.join("\n")}\n` +
        "This happens when a contract field is computed rather than written as an inline " +
        "literal, or when the module changes the capability after `defineCapability()`. Declare the " +
        "contract inline so both readers see the same one.",
    );
  }
}

function describe(value: string | null): string {
  return value === null ? "none" : JSON.stringify(value);
}
