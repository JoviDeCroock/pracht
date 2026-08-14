import { escapeScriptChildren } from "./script-escape.ts";
import { toScriptAttributeRecord } from "./script-policy.ts";
import { SCRIPT_INJECTED_ATTRIBUTE, type ScriptProps } from "./script-types.ts";

/**
 * Module-level registry of scripts already injected in this document. Keyed by
 * `id`, then `src`, then inline content, so the same script is never injected
 * twice across navigations or re-renders.
 */
const injectedScripts = new Set<string>();

/** @internal Reset module state for tests. */
export function resetScriptRegistryForTesting(): void {
  injectedScripts.clear();
}

export function hasInjectedScript(key: string): boolean {
  return injectedScripts.has(key);
}

export function recordInjectedScript(key: string): void {
  injectedScripts.add(key);
}

export function scriptExistsInDocument(props: ScriptProps, inline: string | undefined): boolean {
  if (typeof document === "undefined") return false;
  if (props.id) {
    const element = document.getElementById(props.id);
    // Only a <script> holding the id counts as "already present": an
    // unrelated element that happens to share the id must not silently
    // swallow the script.
    if (element != null) return element.tagName === "SCRIPT";
  }
  const scripts = document.querySelectorAll("script");
  if (props.src) {
    for (const element of scripts) {
      if (element.getAttribute("src") === props.src) return true;
    }
    return false;
  }
  if (inline !== undefined) {
    const escaped = escapeScriptChildren(inline, props.type);
    for (const element of scripts) {
      if (element.textContent === inline || element.textContent === escaped) return true;
    }
  }
  return false;
}

export function injectScriptElement(props: ScriptProps, inline: string | undefined): void {
  const element = document.createElement("script");
  for (const [name, value] of Object.entries(toScriptAttributeRecord(props))) {
    element.setAttribute(name, value);
  }
  element.setAttribute(SCRIPT_INJECTED_ATTRIBUTE, "");
  if (props.src) {
    if (props.onLoad) element.addEventListener("load", props.onLoad);
    if (props.onError) element.addEventListener("error", props.onError);
  } else if (inline !== undefined) {
    element.textContent = inline;
  }
  document.head.appendChild(element);
}

export function scheduleScriptWhenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(() => task());
    return () => {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
    };
  }
  const handle = setTimeout(task, 200);
  return () => clearTimeout(handle);
}

export function scheduleScriptWhenVisible(target: Element | null, task: () => void): () => void {
  if (typeof IntersectionObserver === "undefined" || target == null) {
    // Mirrors the islands `client="visible"` fallback: without an observer
    // (or a placeholder to observe) the script loads immediately.
    task();
    return () => {};
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.disconnect();
      task();
      return;
    }
  });
  observer.observe(target);
  return () => observer.disconnect();
}
