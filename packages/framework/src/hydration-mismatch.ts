import { options as preactOptions } from "preact";
import type { VNode } from "preact";

const HYDRATION_BANNER_ID = "__pracht_hydration_mismatch__";

// Preact flag on vnode.__u for vnodes diffing against existing DOM (hydrate path).
const MODE_HYDRATE = 1 << 5;

interface PreactOptions {
  __m?: (vnode: VNode) => void;
  __e?: (err: unknown, newVNode: VNode, oldVNode: VNode, errorInfo?: unknown) => void;
  __c?: (vnode: VNode, commitQueue: unknown) => void;
}

interface InternalVNode {
  type: VNode["type"] | null;
  props?: unknown;
  __u?: number;
  __h?: unknown;
  __c?: InternalComponent;
  __k?: Array<InternalVNode | null | undefined>;
}

interface InternalComponent {
  __v?: InternalVNode;
}

let installed = false;
let prevMismatch: PreactOptions["__m"];
let prevCatchError: PreactOptions["__e"];
let prevCommit: PreactOptions["__c"];

// Vnodes that suspended while hydrating, awaiting a post-resolve DOM count.
const pendingSuspenseChecks = new Set<InternalVNode>();
let flushScheduled = false;

export function installHydrationMismatchWarning(): void {
  if (installed) return;
  installed = true;

  const opts = preactOptions as PreactOptions;
  prevMismatch = opts.__m;
  prevCatchError = opts.__e;
  prevCommit = opts.__c;

  opts.__m = function (vnode: VNode) {
    appendHydrationWarning(vnode);
    if (prevMismatch) prevMismatch(vnode);
  };

  opts.__e = function (err, newVNode, oldVNode, errorInfo) {
    trackSuspendingVNode(err, newVNode as InternalVNode);
    if (prevCatchError) prevCatchError(err, newVNode, oldVNode, errorInfo);
  };

  opts.__c = function (vnode, commitQueue) {
    if (prevCommit) prevCommit(vnode, commitQueue);
    scheduleSuspenseCheckFlush();
  };
}

function trackSuspendingVNode(err: unknown, vnode: InternalVNode): void {
  if (!vnode) return;
  if (!err || typeof (err as { then?: unknown }).then !== "function") return;
  const isHydratingVNode = !!((vnode.__u && vnode.__u & MODE_HYDRATE) || vnode.__h);
  if (!isHydratingVNode) return;

  const promise = err as PromiseLike<unknown>;
  const onSettle = () => {
    pendingSuspenseChecks.add(vnode);
  };
  promise.then(onSettle, onSettle);
}

function scheduleSuspenseCheckFlush(): void {
  if (flushScheduled) return;
  if (pendingSuspenseChecks.size === 0) return;
  flushScheduled = true;
  queueMicrotask(flushSuspenseChecks);
}

function flushSuspenseChecks(): void {
  flushScheduled = false;
  if (pendingSuspenseChecks.size === 0) return;
  const checks = Array.from(pendingSuspenseChecks);
  pendingSuspenseChecks.clear();
  for (const vnode of checks) {
    const rendered = currentVNode(vnode);
    const count = countTopLevelDomNodes(rendered);
    if (count !== 1) {
      appendSuspenseOffsetWarning(pickReportableVNode(rendered), count);
    }
  }
}

function currentVNode(vnode: InternalVNode): InternalVNode {
  return vnode.__c?.__v ?? vnode;
}

// preact-suspense's `lazy()` returns a function component with
// `displayName === "Lazy"` that renders exactly one child — the resolved
// user component. The lazy wrapper is the vnode that threw, so it's also
// the vnode we captured in __e; for reporting we'd rather show the user's
// actual component name, so drill past Lazy wrappers when we find one.
function pickReportableVNode(vnode: InternalVNode): InternalVNode {
  let current = vnode;
  for (let depth = 0; depth < 4; depth++) {
    if (!isLazyWrapperVNode(current)) break;
    const children = current.__k;
    if (!Array.isArray(children) || children.length !== 1) break;
    const child = children[0];
    if (!child || typeof child.type !== "function") break;
    current = currentVNode(child);
  }
  return current;
}

function isLazyWrapperVNode(vnode: InternalVNode): boolean {
  const type = vnode.type;
  if (typeof type !== "function") return false;
  const fn = type as { displayName?: string; name?: string };
  return fn.displayName === "Lazy" || fn.name === "Lazy";
}

function countTopLevelDomNodes(vnode: InternalVNode | null | undefined): number {
  if (!vnode || typeof vnode !== "object") return 0;
  const type = vnode.type;
  if (type === null) return 1;
  if (typeof type === "string") return 1;
  const children = vnode.__k;
  if (!Array.isArray(children)) return 0;
  let total = 0;
  for (const child of children) {
    total += countTopLevelDomNodes(child);
  }
  return total;
}

function appendSuspenseOffsetWarning(vnode: InternalVNode, count: number): void {
  if (typeof document === "undefined") return;
  const name = getVNodeName(vnode as unknown as VNode);
  const shape = count === 0 ? "rendered 0 DOM nodes" : `rendered ${count} DOM nodes`;
  const message =
    `Suspense boundary resolved during hydration: <${name}> ${shape}. ` +
    `Components that unsuspend during hydration must render exactly one DOM node — ` +
    `otherwise sibling offsets can drift and later updates may bind to the wrong nodes.`;
  appendBannerMessage(message);
}

function appendHydrationWarning(vnode: VNode): void {
  const componentName = getVNodeName(vnode);
  const message = `Hydration mismatch detected on <${componentName}>. The server-rendered HTML did not match the client.`;
  appendBannerMessage(message);
}

function appendBannerMessage(message: string): void {
  if (typeof document === "undefined") return;

  let banner = document.getElementById(HYDRATION_BANNER_ID);
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
  const opts = preactOptions as PreactOptions;
  if (installed) {
    opts.__m = prevMismatch;
    opts.__e = prevCatchError;
    opts.__c = prevCommit;
  }
  installed = false;
  prevMismatch = undefined;
  prevCatchError = undefined;
  prevCommit = undefined;
  pendingSuspenseChecks.clear();
  flushScheduled = false;
}
