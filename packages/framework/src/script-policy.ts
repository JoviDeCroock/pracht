import type { HeadScriptDescriptor } from "./runtime-module-types.ts";
import { SCRIPT_STRATEGIES, type ScriptProps, type ScriptStrategy } from "./script-types.ts";

export function validateScriptStrategy(strategy: ScriptStrategy | undefined): ScriptStrategy {
  if (strategy == null) return "afterHydration";
  if ((SCRIPT_STRATEGIES as readonly string[]).includes(strategy)) return strategy;
  throw new Error(
    `<Script> received an invalid strategy ${JSON.stringify(strategy)}. Expected one of: ` +
      SCRIPT_STRATEGIES.map((value) => `"${value}"`).join(", ") +
      ".",
  );
}

export function normalizeInlineScriptChildren(
  children: ScriptProps["children"],
): string | undefined {
  if (children == null) return undefined;
  const parts = Array.isArray(children) ? children : [children];
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (typeof part !== "string") {
      throw new Error(
        "<Script> inline children must be a string of script source. JSX children are not " +
          "supported — pass the code as a template literal string.",
      );
    }
  }
  return parts.join("");
}

export function getScriptKey(
  props: ScriptProps | HeadScriptDescriptor,
  inline: string | undefined,
): string | null {
  if (props.id) return `id:${props.id}`;
  if (props.src) return `src:${props.src}`;
  if (inline !== undefined) return `inline:${inline}`;
  return null;
}

export function describeScript(props: ScriptProps): string {
  return props.id ?? props.src ?? "inline";
}

/**
 * Allowlisted attribute record. Unknown props — including any `on*` handler —
 * never pass through, matching the head-rendering safety posture in
 * runtime-html.ts.
 */
export function toScriptAttributeRecord(props: ScriptProps): Record<string, string> {
  const out: Record<string, string> = {};
  if (props.src) out.src = props.src;
  if (props.id) out.id = props.id;
  if (props.async) out.async = "";
  if (props.defer) out.defer = "";
  if (props.type) out.type = props.type;
  if (props.nonce) out.nonce = props.nonce;
  if (props.integrity) out.integrity = props.integrity;
  if (props.crossorigin) out.crossorigin = props.crossorigin;
  if (props.referrerpolicy) out.referrerpolicy = props.referrerpolicy;
  return out;
}

export function toHeadScriptDescriptor(
  props: ScriptProps,
  inline: string | undefined,
): HeadScriptDescriptor {
  const descriptor: HeadScriptDescriptor = toScriptAttributeRecord(props);
  if (!props.src && inline !== undefined) {
    descriptor.children = inline;
  }
  return descriptor;
}
