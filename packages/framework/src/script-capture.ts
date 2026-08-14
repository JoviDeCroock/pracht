import { createContext } from "preact";

import type { HydrationMode } from "./route-policy-types.ts";
import type { HeadScriptDescriptor } from "./runtime-module-types.ts";
import { getScriptKey } from "./script-policy.ts";
import type { ScriptCapture } from "./script-types.ts";

export const ScriptCaptureContext = createContext<ScriptCapture | null>(null);

export function createScriptCapture(hydration: HydrationMode): ScriptCapture {
  return { scripts: [], keys: new Set(), hydration };
}

/** Merge captured scripts into the document head without duplicating head() entries. */
export function withCapturedScripts<T extends { script?: HeadScriptDescriptor[] }>(
  head: T,
  capture: ScriptCapture,
): T {
  if (capture.scripts.length === 0) return head;
  const headScripts = head.script ?? [];
  const headKeys = new Set(
    headScripts
      .map((script) => getScriptKey(script, script.children))
      .filter((key): key is string => key !== null),
  );
  const captured = capture.scripts.filter((script) => {
    const key = getScriptKey(script, script.children);
    if (key === null || headKeys.has(key)) return false;
    headKeys.add(key);
    return true;
  });
  if (captured.length === 0) return head;
  return { ...head, script: [...headScripts, ...captured] };
}
