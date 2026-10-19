/**
 * Every way `navigate()` hands a URL back to the browser (a "document exit"),
 * crossed with the four ways a navigation starts: a push, a replace, a
 * history traversal (`popstate`), and the static-export SPA fallback boot
 * (`200.html`, which navigates with `{ replace: true, _staticFallback: true }`).
 *
 * Each cell states the contract, not merely today's output:
 * - push: a document navigation that adds an entry (`pushes`);
 * - replace: one that takes over the current entry (`replaces`);
 * - popstate: the browser already moved the entry, so a document load of that
 *   same URL is fine in any form (`inPlace`), while a load of another URL
 *   (a redirect's target) must replace it;
 * - static fallback: the host answers the boot URL with this same fallback
 *   document, so handing that URL back loops; a hand-off to another URL must
 *   replace the boot entry.
 *
 * A cell whose `fails` is set records a bug: today's behaviour breaks the
 * contract, so it runs as `it.fails` until `leaveToDocument()` lands.
 */
import { h } from "preact";
import { describe, expect, it } from "vitest";

import { defineApp, resolveApp, route } from "../src/index.ts";
import {
  chunkFailure,
  inPlace,
  matchesHandoffs,
  mountRouter,
  pushes,
  replaces,
  reply,
  type HandoffMatcher,
  type RouterHarness,
  type StateReply,
} from "./router-harness.ts";

export type ExitMode = "push" | "replace" | "popstate" | "staticFallback";

export function createExitApp(renderMode: "ssr" | "spa") {
  return resolveApp(
    defineApp({
      routes: [
        route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
        route("/a", "./routes/a.tsx", { id: "a", render: renderMode }),
        route("/b", "./routes/b.tsx", { id: "b", render: renderMode }),
        route("/mpa", "./routes/mpa.tsx", { id: "mpa", render: "ssr", hydration: "islands" }),
        route("/r/:n", "./routes/r.tsx", { id: "r", render: renderMode }),
        route("/chunk", "./routes/chunk.tsx", { id: "chunk", render: renderMode }),
        route("/crash", "./routes/crash.tsx", { id: "crash", render: renderMode }),
      ],
      notFound: "./routes/not-found.tsx",
    }),
  );
}

export function createExitModules(): Record<string, () => Promise<unknown>> {
  const page = (text: string) => async () => ({ default: () => h("main", null, text) });
  return {
    "./routes/home.tsx": page("home"),
    "./routes/a.tsx": page("page a"),
    "./routes/b.tsx": page("page b"),
    "./routes/mpa.tsx": page("mpa"),
    "./routes/r.tsx": page("r"),
    "./routes/chunk.tsx": chunkFailure,
    "./routes/crash.tsx": async () => ({
      default: (): never => {
        throw new Error("render crash");
      },
    }),
    "./routes/not-found.tsx": page("404"),
  };
}

/** `/r/0` → `/r/1` → … one hop past the router's redirect limit (20). */
export function redirectChain(): Record<string, StateReply> {
  const state: Record<string, StateReply> = {};
  for (let n = 0; n <= 25; n++) state[`/r/${n}`] = reply.redirect(`/r/${n + 1}`);
  return state;
}

interface Cell {
  /** The URL navigated to, or booted at. Default: the row's `path`. */
  path?: string;
  /** Route-state replies. Default: the row's `state`. */
  state?: Record<string, StateReply>;
  /** Every hand-off, in order. Empty: the browser is never handed a URL. */
  expect: HandoffMatcher[];
  /** Text the router must render instead, when it does not leave. */
  renders?: string;
  /** A console error the router must log. */
  logs?: RegExp;
  /**
   * Today's behaviour breaks the contract. The row runs as `it.fails`, and
   * only while today's hand-off is still the single `location.href`
   * assignment recorded here: once that changes, the row reports itself so it
   * can be turned into a plain `it`.
   */
  fails?: { todayHref: string; why: string };
}

interface NotApplicable {
  na: string;
}

export interface ExitRow {
  /** The `LeaveReason` (with a variant suffix where one reason has two triggers). */
  reason: string;
  path: string;
  state?: Record<string, StateReply>;
  /** The navigation commits before it leaves (the URL is already the target's). */
  commits?: boolean;
  push: Cell;
  replace: Cell;
  popstate: Cell | NotApplicable;
  staticFallback: Cell | NotApplicable;
}

const EXTERNAL = "https://elsewhere.example/x";
const UNSAFE = "javascript:alert(1)";
const SAME_ORIGIN_ONLY = "a traversal or a fallback boot lands on a same-origin URL";

export const EXIT_ROWS: ExitRow[] = [
  {
    reason: "unmatched",
    path: "/nowhere",
    push: { expect: [pushes("/nowhere")] },
    replace: {
      expect: [replaces("/nowhere")],
      fails: {
        todayHref: "/nowhere",
        why: "the unmatched exit assigns location.href and ignores replace",
      }, // seams step G
    },
    popstate: { expect: [inPlace("/nowhere")] },
    // The boot only navigates a matched SPA route, so it reaches this exit
    // through a redirect.
    staticFallback: {
      path: "/a",
      state: { "/a": reply.redirect("/nowhere") },
      expect: [replaces("/nowhere")],
      fails: {
        todayHref: "/nowhere",
        why: "the redirect target leaves by href, keeping the redirecting boot entry",
      }, // seams step G
    },
  },
  {
    reason: "mpa-route",
    path: "/mpa",
    push: { expect: [pushes("/mpa")] },
    replace: {
      expect: [replaces("/mpa")],
      fails: {
        todayHref: "/mpa",
        why: "the islands/none exit assigns location.href and ignores replace",
      }, // seams step G
    },
    popstate: { expect: [inPlace("/mpa")] },
    staticFallback: {
      path: "/a",
      state: { "/a": reply.redirect("/mpa") },
      expect: [replaces("/mpa")],
      fails: {
        todayHref: "/mpa",
        why: "the redirect target leaves by href, keeping the redirecting boot entry",
      }, // seams step G
    },
  },
  {
    reason: "unsafe-or-external:unsafe-url",
    path: UNSAFE,
    push: { expect: [], logs: /refused to navigate to unsafe URL/ },
    replace: { expect: [], logs: /refused to navigate to unsafe URL/ },
    popstate: { na: SAME_ORIGIN_ONLY },
    staticFallback: { na: SAME_ORIGIN_ONLY },
  },
  {
    reason: "unsafe-or-external:unsafe-redirect",
    path: "/a",
    state: { "/a": reply.redirect(UNSAFE) },
    push: { expect: [], logs: /refused to navigate to unsafe URL/ },
    replace: { expect: [], logs: /refused to navigate to unsafe URL/ },
    popstate: { expect: [], logs: /refused to navigate to unsafe URL/ },
    staticFallback: { expect: [], logs: /refused to navigate to unsafe URL/ },
  },
  {
    reason: "unsafe-or-external:external-url",
    path: EXTERNAL,
    push: { expect: [pushes(EXTERNAL)] },
    replace: {
      expect: [replaces(EXTERNAL)],
      fails: {
        todayHref: EXTERNAL,
        why: "the external-URL exit assigns location.href and ignores replace",
      }, // seams step G
    },
    popstate: { na: SAME_ORIGIN_ONLY },
    staticFallback: { na: SAME_ORIGIN_ONLY },
  },
  {
    reason: "unsafe-or-external:external-redirect",
    path: "/a",
    state: { "/a": reply.redirect(EXTERNAL) },
    push: { expect: [pushes(EXTERNAL)] },
    replace: {
      expect: [replaces(EXTERNAL)],
      fails: {
        todayHref: EXTERNAL,
        why: "the external-redirect exit assigns location.href and ignores replace",
      }, // seams step G
    },
    popstate: {
      expect: [replaces(EXTERNAL)],
      fails: {
        todayHref: EXTERNAL,
        why: "a traversal's redirect adds an entry, so Back lands on the redirect again",
      }, // seams step G
    },
    staticFallback: {
      expect: [replaces(EXTERNAL)],
      fails: {
        todayHref: EXTERNAL,
        why: "the boot's redirect adds an entry, so Back lands on the redirect again",
      }, // seams step G
    },
  },
  {
    reason: "unsafe-or-external:hash-redirect",
    path: "/a",
    state: { "/a": reply.redirect("/b#section") },
    push: { expect: [pushes("/b#section")] },
    replace: {
      expect: [replaces("/b#section")],
      fails: {
        todayHref: "/b#section",
        why: "the same-origin fragment-redirect exit ignores replace",
      }, // seams step G
    },
    popstate: {
      expect: [replaces("/b#section")],
      fails: {
        todayHref: "/b#section",
        why: "a traversal's redirect adds an entry, so Back lands on the redirect again",
      }, // seams step G
    },
    staticFallback: {
      expect: [replaces("/b#section")],
      fails: {
        todayHref: "/b#section",
        why: "the boot's redirect adds an entry, so Back lands on the redirect again",
      }, // seams step G
    },
  },
  {
    reason: "redirect-overflow",
    path: "/r/0",
    state: redirectChain(),
    push: { expect: [pushes("/r/20")], logs: /too many redirects/ },
    replace: {
      expect: [replaces("/r/20")],
      logs: /too many redirects/,
      fails: { todayHref: "/r/20", why: "the redirect-overflow exit ignores replace" }, // seams step G
    },
    popstate: {
      expect: [replaces("/r/20")],
      logs: /too many redirects/,
      fails: {
        todayHref: "/r/20",
        why: "a traversal's redirect chain leaves by href onto another URL",
      }, // seams step G
    },
    // Static redirects are followed only by the client, so handing the chain
    // to the fallback document restarts it there: a cycle never ends.
    staticFallback: {
      expect: [],
      logs: /too many redirects/,
      fails: {
        todayHref: "/r/20",
        why: "the fallback hands the chain to a document that restarts it",
      }, // seams step G
    },
  },
  {
    reason: "opaque-redirect",
    path: "/a",
    state: { "/a": reply.opaqueRedirect() },
    push: { expect: [pushes("/a")] },
    replace: {
      expect: [replaces("/a")],
      fails: {
        todayHref: "/a",
        why: "the opaque-redirect exit assigns location.href and ignores replace",
      }, // seams step G
    },
    popstate: { expect: [inPlace("/a")] },
    staticFallback: {
      expect: [],
      fails: {
        todayHref: "/a",
        why: "the fallback hands its own URL back to the host, which serves the fallback again",
      }, // seams step G
    },
  },
  {
    reason: "fetch-failed",
    path: "/a",
    state: { "/a": reply.networkError() },
    push: { expect: [pushes("/a")] },
    replace: {
      expect: [replaces("/a")],
      fails: {
        todayHref: "/a",
        why: "the fetch-failed exit assigns location.href and ignores replace",
      }, // seams step G
    },
    popstate: { expect: [inPlace("/a")] },
    staticFallback: { expect: [], renders: "page a" },
  },
  {
    reason: "chunk-failed",
    path: "/chunk",
    push: { expect: [pushes("/chunk")] },
    replace: { expect: [replaces("/chunk")] },
    popstate: { expect: [inPlace("/chunk")] },
    staticFallback: { expect: [], logs: /could not load the route module/ },
  },
  {
    reason: "render-error",
    path: "/crash",
    commits: true,
    push: { expect: [inPlace("/crash")] },
    replace: { expect: [inPlace("/crash")] },
    popstate: { expect: [inPlace("/crash")] },
    staticFallback: { expect: [] },
  },
  {
    reason: "not-found-no-boundary",
    path: "/a",
    state: { "/a": reply.error(404) },
    push: { expect: [pushes("/a")] },
    replace: {
      expect: [replaces("/a")],
      fails: {
        todayHref: "/a",
        why: "the not-found exit assigns location.href and ignores replace",
      }, // seams step G
    },
    popstate: { expect: [inPlace("/a")] },
    staticFallback: {
      expect: [],
      fails: {
        todayHref: "/a",
        why: "the fallback hands its own URL back to the host, which serves the fallback again",
      }, // seams step G
    },
  },
];

async function drive(mode: ExitMode, row: ExitRow, cell: Cell): Promise<RouterHarness> {
  const path = cell.path ?? row.path;
  const state = cell.state ?? row.state;
  const renderMode = mode === "staticFallback" ? "spa" : "ssr";
  const base = {
    app: createExitApp(renderMode),
    routeModules: createExitModules(),
    state,
  };
  if (mode === "staticFallback") {
    return mountRouter({ ...base, url: path, staticFallbackBoot: true });
  }
  const harness = await mountRouter(base);
  if (mode === "push") await harness.navigate(path);
  else if (mode === "replace") await harness.navigate(path, { replace: true });
  else await harness.popstate(path);
  return harness;
}

/** Register the table for `modes`; the caller sets up the build target. */
export function defineExitTable(modes: readonly ExitMode[]): void {
  for (const row of EXIT_ROWS) {
    if (modes.every((mode) => "na" in row[mode])) continue;
    describe(row.reason, () => {
      for (const mode of modes) {
        const cell = row[mode];
        if ("na" in cell) continue;
        const name = `${mode}: ${cell.expect.length === 0 ? "stays" : "leaves"}`;
        const body = async () => {
          const lengthBefore = history.length;
          const harness = await drive(mode, row, cell);
          if (cell.fails) {
            const today = harness.handoffs;
            const unchanged =
              today.length === 1 &&
              today[0].kind === "href" &&
              today[0].url === cell.fails.todayHref;
            // Returning without throwing makes `it.fails` report the row.
            if (!unchanged) return;
          }
          expect(
            matchesHandoffs(harness.handoffs, cell.expect),
            `hand-offs ${JSON.stringify(harness.handoffs)} ≠ ${JSON.stringify(cell.expect)}`,
          ).toBe(true);
          if (cell.renders) expect(harness.root.textContent).toBe(cell.renders);
          if (cell.logs) {
            expect(harness.errors.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
              cell.logs,
            );
          }
          // A navigation that leaves never committed, so the URL bar still
          // shows the page on screen.
          if ((mode === "push" || mode === "replace") && cell.expect.length > 0 && !row.commits) {
            expect(window.location.pathname).toBe("/");
            expect(history.length).toBe(lengthBefore);
          }
        };
        if (cell.fails) {
          // seams step G
          it.fails(`${name} (${cell.fails.why})`, body);
        } else {
          it(name, body);
        }
      }
    });
  }
}
