import { options as preactOptions } from "preact";
import type { VNode } from "preact";

const HYDRATION_BANNER_ID = "__pracht_hydration_mismatch__";

let installed = false;

export function installHydrationMismatchWarning(): void {
  if (installed) return;
  installed = true;

  const prev = (preactOptions as { __m?: (vnode: VNode) => void }).__m;
  (preactOptions as { __m?: (vnode: VNode) => void }).__m = function (vnode: VNode) {
    appendHydrationWarning(vnode);
    if (prev) prev(vnode);
  };
}

function appendHydrationWarning(vnode: VNode): void {
  if (typeof document === "undefined") return;

  const componentName = getVNodeName(vnode);
  let banner = document.getElementById(HYDRATION_BANNER_ID);
  const message = `Hydration mismatch detected on <${componentName}>. The server-rendered HTML did not match the client.`;

  if (banner) {
    const list = banner.querySelector(`[data-pracht-mismatch-list]`);
    if (list) {
      const item = document.createElement("li");
      item.textContent = message;
      list.appendChild(item);
    }
    return;
  }

  banner = document.createElement("div");
  banner.id = HYDRATION_BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "z-index:2147483647",
    "background:#1a1a2e",
    "color:#ff6b6b",
    "padding:12px 16px",
    "font:12px/1.5 ui-monospace,Menlo,Consolas,monospace",
    "border-bottom:2px solid #e74c3c",
    "box-shadow:0 2px 8px rgba(0,0,0,0.3)",
  ].join(";");

  const title = document.createElement("strong");
  title.textContent = "pracht: hydration mismatch";
  title.style.cssText = "display:block;margin-bottom:4px;color:#fff";
  banner.appendChild(title);

  const list = document.createElement("ul");
  list.setAttribute("data-pracht-mismatch-list", "");
  list.style.cssText = "margin:0;padding-left:18px";
  const item = document.createElement("li");
  item.textContent = message;
  list.appendChild(item);
  banner.appendChild(list);

  document.body.appendChild(banner);
}

function getVNodeName(vnode: VNode | null | undefined): string {
  if (!vnode) return "Unknown";
  const type = vnode.type as unknown;
  if (typeof type === "string") return type;
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || "Component";
  }
  return "Unknown";
}

export function _resetHydrationMismatchForTesting(): void {
  installed = false;
  (preactOptions as { __m?: (vnode: VNode) => void }).__m = undefined;
}
