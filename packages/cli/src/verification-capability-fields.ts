import { isValidCapabilityHttpPath } from "@pracht/capabilities";
import { evaluateLiteral } from "@pracht/capabilities/static";

export type StaticString =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "valid"; value: string };

export function readStaticString(text: string | undefined): StaticString {
  if (!text) return { kind: "absent" };
  const value = evaluateLiteral(text);
  if (value === undefined) return { kind: "unknown" };
  if (typeof value !== "string" || value.trim() === "") return { kind: "invalid" };
  return { kind: "valid", value };
}

export type MiddlewareNames =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "valid"; names: string[] };

export function readMiddlewareNames(text: string | undefined): MiddlewareNames {
  if (!text) return { kind: "absent" };
  const value = evaluateLiteral(text);
  if (value === undefined) return { kind: "unknown" };
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    return { kind: "invalid" };
  }
  return { kind: "valid", names: value };
}

export interface CapabilityExposeFlags {
  hasHttp: boolean;
  hasMcp: boolean;
  hasWebmcp: boolean;
  /** `expose` is present but not an inline literal, so it cannot be verified. */
  unknown: boolean;
  problems: string[];
}

export function readExposeFlags(text: string | undefined): CapabilityExposeFlags {
  if (text === undefined) {
    return { hasHttp: false, hasMcp: false, hasWebmcp: false, unknown: false, problems: [] };
  }
  const value = evaluateLiteral(text);
  if (value === undefined) {
    return { hasHttp: false, hasMcp: false, hasWebmcp: false, unknown: true, problems: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      hasHttp: false,
      hasMcp: false,
      hasWebmcp: false,
      unknown: false,
      problems: ['"expose" must be an inline object literal'],
    };
  }

  const expose = value as Record<string, unknown>;
  const problems: string[] = [];
  let hasHttp = false;
  if (expose.http === true) {
    hasHttp = true;
  } else if (expose.http && typeof expose.http === "object" && !Array.isArray(expose.http)) {
    hasHttp = true;
    const http = expose.http as Record<string, unknown>;
    if (http.method !== undefined && http.method !== "POST") {
      problems.push('HTTP exposure only supports method: "POST"');
    }
    if (http.path !== undefined && !isValidCapabilityHttpPath(http.path)) {
      problems.push('HTTP exposure "path" must be an exact same-origin pathname starting with "/"');
    }
  } else if (expose.http !== undefined && expose.http !== false && expose.http !== null) {
    problems.push('"expose.http" must be true or an object');
  }

  return {
    hasHttp,
    hasMcp: expose.mcp === true,
    hasWebmcp: expose.webmcp === true,
    unknown: false,
    problems,
  };
}
