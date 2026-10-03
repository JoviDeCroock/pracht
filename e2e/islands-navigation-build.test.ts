import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { fixtureCopyFilter } from "./fixture-copy.ts";
import { acquireE2EWorkerPort, type E2EWorkerPortLease } from "./ports.ts";

// `pracht({ client: { islandsNavigation: true } })` production coverage. Builds
// examples/islands with the flag on, plus a lab of pages that each pin one
// behaviour, and proves in a real browser that links between islands pages
// swap the page into the same document — and that everything the swap cannot
// reproduce faithfully (another document policy, a full-hydration page, an API
// route, a meta CSP, reordered stylesheets) is a single ordinary page load.
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureDir = resolve(repoRoot, "examples/islands");
const cliEntry = resolve(repoRoot, "packages/cli/bin/pracht.js");

const LAB_PAGES = [
  "a",
  "b",
  "scripts",
  "noscript",
  "csp",
  "deny",
  "redir",
  "token",
  "sso",
  "css1",
  "css2",
  "colored",
  "metacsp",
  "deep/target",
  "nonce",
  "refresh",
  "referrer",
  "tt",
  "tt2",
  "slot1",
  "slot2",
  "slot3",
];

const LAB_FILES: Record<string, string> = {
  "src/shells/lab.tsx": `
import type { ShellProps } from "@pracht/core";
import ShellCounter from "../islands/ShellCounter.tsx";
export function Shell({ children }: ShellProps) {
  return (
    <div>
      <nav>
        {${JSON.stringify(LAB_PAGES)}.map((p) => <a href={"/lab/" + p} id={"go-" + p.replace("/", "-")}>{p}</a>)}
        <a href="/lab-full" id="go-full">full</a>
        <a href="/api/lab-api" id="go-api">api</a>
        <a href="/lab/b" id="go-b-reload" data-pracht-reload>reload b</a>
        <a href="/lab/files/report.zip" id="go-zip">zip</a>
        <a href="/lab/p/%E0%A4%A" id="go-undecodable">undecodable</a>
      </nav>
      <ShellCounter />
      <main>{children}</main>
    </div>
  );
}
export function head() {
  return {
    // A theme script that adds a style the server never rendered.
    script: [{ children: "if(!document.getElementById('theme')){var s=document.createElement('style');s.id='theme';s.textContent='body{outline:3px solid rgb(1, 2, 3)}';document.head.appendChild(s)}" }],
  };
}
`,
  "src/islands/Scroller.tsx": `
import { useState } from "preact/hooks";
export default function Scroller() {
  const [n, setN] = useState(0);
  return (
    <div>
      <button data-testid="scroller-inc" onClick={() => setN(n + 1)}>scroller {n}</button>
      <input data-testid="scroller-input" />
      <div data-testid="scrollbox" style="height:60px;overflow:auto"><div style="height:1000px">tall</div></div>
      <iframe data-testid="scroller-frame" srcdoc="<p>frame</p>" style="height:40px"></iframe>
    </div>
  );
}
`,
  "src/routes/lab/a.tsx": `import Scroller from "../../islands/Scroller.tsx";
export function head() { return { title: "A" }; }
export function Component() { return <section><h1>A</h1><Scroller /></section>; }`,
  "src/routes/lab/b.tsx": `import Scroller from "../../islands/Scroller.tsx";
export function head() { return { title: "B" }; }
export function Component() { return <section><h1>B</h1><Scroller /></section>; }`,
  "src/routes/lab/scripts.tsx": `export function head() {
  return { title: "Scripts", script: [{ src: "/lab-lib.js" }, { children: "window.inlineRuns=(window.inlineRuns||0)+1;window.libSeenByInline=typeof window.LIB!=='undefined';" }] };
}
export function Component() { return <section><h1>Scripts</h1></section>; }`,
  "src/routes/lab/noscript.tsx": `export function head() { return { title: "Noscript" }; }
export function Component() {
  return <section><h1>Noscript</h1><noscript><img src="/lab-pixel.svg?noscript=1" alt="" /><link rel="stylesheet" href="/lab-nojs.css" /></noscript></section>;
}`,
  "src/routes/lab/csp.tsx": `export function head() { return { title: "CSP" }; }
export function headers() { return { "content-security-policy": "script-src 'self'" }; }
export function Component() {
  return <section><h1>CSP</h1><div dangerouslySetInnerHTML={{ __html: "<script>window.cspBypassed = true<\\/script>" }} /></section>;
}`,
  "src/routes/lab/relaxed.tsx": `export function head() { return { title: "Relaxed" }; }
export function headers() { return { "content-security-policy": "script-src 'self'" }; }
export function Component() { return <section><h1>Relaxed</h1></section>; }`,
  // Loosens the CSP the page set, after it was rendered.
  "src/middleware/lab-relax.ts": `import type { MiddlewareFn } from "@pracht/core";
export const middleware: MiddlewareFn = async (_args, next) => {
  const response = await next();
  response.headers.set("content-security-policy", "script-src 'self' 'unsafe-inline'");
  return response;
};`,
  "src/routes/lab/deny.tsx": `export function head() { return { title: "Deny" }; }
export function headers() { return { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" }; }
export function Component() { return <section><h1>Deny</h1><button id="danger">Delete account</button></section>; }`,
  "src/routes/lab/redir.tsx": `import { redirect } from "@pracht/core";
export function loader() { return redirect("/lab/deep/target"); }
export function Component() { return <h1>never</h1>; }`,
  "src/routes/lab/target.tsx": `export function head() { return { title: "Target" }; }
export function Component() { return <section><h1>Target</h1><img id="relimg" src="rel.svg" alt="" /></section>; }`,
  "src/routes/lab/token.tsx": `import { redirect } from "@pracht/core";
const g = globalThis as { tokenUsed?: boolean };
export function loader() {
  if (g.tokenUsed) return redirect("/lab-full?err=token-already-used");
  g.tokenUsed = true;
  return redirect("/lab-full?ok=1");
}
export function Component() { return <h1>never</h1>; }`,
  "src/routes/lab/sso.tsx": `import { redirect } from "@pracht/core";
const g = globalThis as { ssoRedirects?: number };
export function loader() { g.ssoRedirects = (g.ssoRedirects ?? 0) + 1; return redirect("http://sso.test/login?n=" + g.ssoRedirects); }
export function Component() { return <h1>never</h1>; }`,
  "src/routes/lab/css1.tsx": `export function head() {
  return { title: "Css1", link: [{ rel: "stylesheet", href: "/lab-s1.css" }, { rel: "stylesheet", href: "/lab-s2.css" }] };
}
export function Component() { return <section><h1>Css1</h1></section>; }`,
  "src/routes/lab/css2.tsx": `export function head() {
  return { title: "Css2", link: [{ rel: "stylesheet", href: "/lab-s2.css" }, { rel: "stylesheet", href: "/lab-s1.css" }] };
}
export function Component() { return <section><h1>Css2</h1></section>; }`,
  "src/routes/lab/colored.tsx": `export function head() { return { title: "Colored", link: [{ rel: "stylesheet", href: "/lab-red.css" }] }; }
export function Component() { return <section><h1>Colored</h1></section>; }`,
  "src/routes/lab/metacsp.tsx": `export function head() { return { title: "MetaCSP", meta: [{ "http-equiv": "Content-Security-Policy", content: "img-src 'none'" }] }; }
export function Component() { return <section><h1>MetaCSP</h1></section>; }`,
  "src/routes/lab/full.tsx": `const g = globalThis as { fullRenders?: number };
export function loader() { g.fullRenders = (g.fullRenders ?? 0) + 1; return { n: g.fullRenders }; }
export function Component({ data }: { data: { n: number } }) { return <section><h1>Full</h1><p id="n">{data.n}</p></section>; }`,
  "src/routes/lab/nonce.tsx": `export function head() { return { title: "Nonce" }; }
export function headers() { return { "content-security-policy": "script-src 'self' 'nonce-abc123'" }; }
export function Component() { return <section><h1>Nonce</h1></section>; }`,
  "src/routes/lab/refresh.tsx": `export function head() { return { title: "Refresh", meta: [{ "http-equiv": "refresh", content: "600" }] }; }
export function Component() { return <section><h1>Refresh</h1></section>; }`,
  "src/routes/lab/referrer.tsx": `export function head() { return { title: "Referrer", meta: [{ name: "referrer", content: "no-referrer" }] }; }
export function Component() { return <section><h1>Referrer</h1></section>; }`,
  "src/routes/lab/tt.tsx": `export function head() { return { title: "TT" }; }
export function headers() { return { "content-security-policy": "require-trusted-types-for 'script'" }; }
export function Component() { return <section><h1>TT</h1></section>; }`,
  "src/routes/lab/tt2.tsx": `export function head() { return { title: "TT2" }; }
export function headers() { return { "content-security-policy": "require-trusted-types-for 'script'" }; }
export function Component() { return <section><h1>TT2</h1></section>; }`,
  // One disclosure island on each page, passed the same children on slot1 and
  // slot3 (a counter island among them) and other children on slot2.
  "src/routes/lab/slot1.tsx": `import Counter from "../../islands/Counter.tsx";
import Disclosure from "../../islands/Disclosure.tsx";
export function head() { return { title: "Slot1" }; }
export function Component() {
  return <section><h1>Slot1</h1><Disclosure summary="Shared" open><p data-testid="slot-text">one</p><Counter start={10} /></Disclosure></section>;
}`,
  "src/routes/lab/slot2.tsx": `import Disclosure from "../../islands/Disclosure.tsx";
export function head() { return { title: "Slot2" }; }
export function Component() {
  return <section><h1>Slot2</h1><Disclosure summary="Shared" open><p data-testid="slot-text">two</p></Disclosure></section>;
}`,
  "src/routes/lab/slot3.tsx": `import Counter from "../../islands/Counter.tsx";
import Disclosure from "../../islands/Disclosure.tsx";
export function head() { return { title: "Slot3" }; }
export function Component() {
  return <section><h1>Slot3</h1><Disclosure summary="Shared" open><p data-testid="slot-text">one</p><Counter start={10} /></Disclosure></section>;
}`,
  "src/routes/lab/files.tsx": `export function Component() { return <section><h1>Files</h1></section>; }`,
  "src/routes/lab/param.tsx": `export function Component() { return <section><h1>Param</h1></section>; }`,
  "public/lab/files/report.zip": "PK not really a zip",
  "src/api/lab-api.ts": `export function GET() { return new Response("{}", { headers: { "content-type": "application/json" } }); }`,
  "public/lab-lib.js": "window.libRuns=(window.libRuns||0)+1;window.LIB=1;",
  "public/lab-pixel.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  "public/lab-nojs.css": "body{background:rgb(255, 0, 0)}",
  "public/lab-s1.css": "h1{color:rgb(0, 0, 255)}",
  "public/lab-s2.css": "h1{color:rgb(0, 128, 0)}",
  "public/lab-red.css": "h1{color:rgb(200, 0, 0)}",
  "public/lab/deep/rel.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
};

const LAB_ROUTES = `
    group({ shell: "lab", hydration: "islands", render: "ssr" }, [
${LAB_PAGES.map(
  (page) =>
    `      route("/lab/${page}", () => import("./routes/lab/${page === "deep/target" ? "target" : page}.tsx")),`,
).join("\n")}
      route("/lab/relaxed", () => import("./routes/lab/relaxed.tsx"), { middleware: ["labRelax"] }),
      route("/lab/files/*", () => import("./routes/lab/files.tsx")),
      route("/lab/p/:slug", () => import("./routes/lab/param.tsx")),
    ]),
    group({ shell: "lab", render: "ssr" }, [
      route("/lab-full", () => import("./routes/lab/full.tsx")),
    ]),
  ],
});
`;

test.describe.serial("islands navigation", () => {
  let tempDir: string;
  let server: ReturnType<typeof spawn> | undefined;
  let portLease: E2EWorkerPortLease | undefined;
  let origin: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const tempRoot = resolve(repoRoot, ".tmp");
    mkdirSync(tempRoot, { recursive: true });
    tempDir = mkdtempSync(resolve(tempRoot, "pracht-islands-navigation-"));
    const exampleDir = resolve(tempDir, "project");
    cpSync(fixtureDir, exampleDir, { filter: fixtureCopyFilter(fixtureDir), recursive: true });

    const configPath = resolve(exampleDir, "vite.config.ts");
    const config = readFileSync(configPath, "utf-8");
    const enabled = config.replace(
      "pracht({ adapter: nodeAdapter() })",
      "pracht({ adapter: nodeAdapter(), client: { islandsNavigation: true } })",
    );
    expect(enabled).not.toBe(config);
    writeFileSync(configPath, enabled);

    const routesPath = resolve(exampleDir, "src/routes.ts");
    const routes = readFileSync(routesPath, "utf-8")
      .replace(/\n {2}\],\n\}\);\n$/, LAB_ROUTES)
      .replace(
        'guide: () => import("./shells/guide.tsx"),',
        'guide: () => import("./shells/guide.tsx"),\n    lab: () => import("./shells/lab.tsx"),',
      )
      .replace(
        "viewTransitions: true,",
        'viewTransitions: true,\n  middleware: { labRelax: "./middleware/lab-relax.ts" },',
      );
    expect(routes).toContain('route("/lab/a"');
    expect(routes).toContain("lab: () =>");
    expect(routes).toContain("labRelax");
    writeFileSync(routesPath, routes);
    for (const [path, source] of Object.entries(LAB_FILES)) {
      mkdirSync(dirname(resolve(exampleDir, path)), { recursive: true });
      writeFileSync(resolve(exampleDir, path), source);
    }

    execFileSync(process.execPath, [cliEntry, "build"], {
      cwd: exampleDir,
      env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
      stdio: "pipe",
    });

    portLease = await acquireE2EWorkerPort();
    const { port } = portLease;
    server = spawn(process.execPath, [resolve(exampleDir, "dist/server/server.js")], {
      cwd: exampleDir,
      env: { ...process.env, PORT: String(port) },
      stdio: "pipe",
    });
    origin = `http://127.0.0.1:${port}`;
    await waitForServer(`${origin}/guide`);
  });

  test.afterAll(async () => {
    if (server) {
      server.kill("SIGTERM");
      await waitForExit(server);
    }
    portLease?.release();
    rmSync(tempDir, { force: true, recursive: true });
  });

  test("swaps islands pages in place", async ({ page }) => {
    const documents = recordDocuments(page);
    const counterStylesheets = () =>
      page.locator('head link[rel="stylesheet"][href*="/assets/Counter-"]').count();

    await page.goto(`${origin}/guide`);
    await hydrated(page);
    await page.evaluate(() => {
      (window as { marker?: string }).marker = "first document";
      // Tall enough to scroll, so traversal can be checked for restoring it.
      document.body.style.minHeight = "4000px";
    });
    await page.getByTestId("shell-increment").click();
    await page.getByTestId("shell-increment").click();
    await expect(page.getByTestId("shell-count")).toHaveText("2");
    expect(await counterStylesheets()).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 900));

    // Islands page to islands page (SSG to SSR): same document, new content,
    // new title, the shell island carried over with its state, the new island
    // hydrated with its stylesheet, and the page scrolled to the top.
    await clickInPlace(page, 'nav a[href="/guide/next"]');
    await expect(page.locator("h1")).toHaveText("Next page");
    expect(await sameDocument(page)).toBe("first document");
    await expect(page).toHaveTitle("Next — Pracht Islands Example");
    await expect(page.getByTestId("shell-count")).toHaveText("2");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await hydrated(page);
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 2");
    expect(await counterStylesheets()).toBe(1);

    // Back: the old page returns with its scroll position, and the island and
    // stylesheet only the other page had are gone.
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Guide");
    expect(await sameDocument(page)).toBe("first document");
    await expect(page).toHaveURL(`${origin}/guide`);
    await expect(page.getByTestId("shell-count")).toHaveText("2");
    await expect(page.locator('pracht-island[island="/src/islands/Counter.tsx"]')).toHaveCount(0);
    expect(await counterStylesheets()).toBe(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(900);

    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Next page");

    // An islands page to a hydration: "none" page is a swap as well.
    await page.click('nav a[href="/static"]');
    await expect(page.locator("h1")).toHaveText("Fully static");
    expect(await sameDocument(page)).toBe("first document");
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Next page");

    // A navigation interrupted by another never lands. Its history entry was
    // already committed, as a client-router push's is.
    await page.route(`${origin}/guide`, async (route) => {
      await new Promise((settle) => setTimeout(settle, 1_500));
      await route.continue().catch(() => {});
    });
    await page.click('nav a[href="/guide"]');
    await page.click('nav a[href="/static"]');
    await expect(page.locator("h1")).toHaveText("Fully static");
    await page.waitForTimeout(2_000);
    await expect(page.locator("h1")).toHaveText("Fully static");
    await expect(page).toHaveURL(`${origin}/static`);
    await page.unroute(`${origin}/guide`);
    expect(documents).toEqual(["/guide"]);
  });

  test("keeps a carried island's DOM state", async ({ page }) => {
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => {
      (window as { marker?: string }).marker = "first document";
      document.querySelector('[data-testid="scrollbox"]')!.scrollTop = 300;
      const frame = document.querySelector<HTMLIFrameElement>('[data-testid="scroller-frame"]')!;
      (frame.contentWindow as { frameMarker?: string }).frameMarker = "alive";
    });
    await page.getByTestId("scroller-inc").click();
    await page.getByTestId("scroller-input").fill("typed");

    await clickInPlace(page, "#go-b");
    await expect(page.locator("h1")).toHaveText("B");
    expect(await sameDocument(page)).toBe("first document");
    expect(
      await page.evaluate(() => ({
        count: document.querySelector('[data-testid="scroller-inc"]')!.textContent,
        input: document.querySelector<HTMLInputElement>('[data-testid="scroller-input"]')!.value,
        scrollTop: document.querySelector('[data-testid="scrollbox"]')!.scrollTop,
        frame: (
          document.querySelector<HTMLIFrameElement>('[data-testid="scroller-frame"]')!
            .contentWindow as { frameMarker?: string }
        ).frameMarker,
        // The theme script's style is not the server's, so it stays.
        theme: !!document.getElementById("theme"),
      })),
    ).toEqual({ count: "scroller 1", input: "typed", scrollTop: 300, frame: "alive", theme: true });

    // Focus inside a carried island stays there, so typing can go on.
    await page.getByTestId("scroller-input").focus();
    await page.evaluate(() => navigation.navigate("/lab/a"));
    await expect(page.locator("h1")).toHaveText("A");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "scroller-input",
    );
    await page.keyboard.type("!");
    await expect(page.getByTestId("scroller-input")).toHaveValue("typed!");

    // Focus on something the swap replaced starts over at the top of the new
    // page, as after a page load.
    await page.focus("#go-b");
    await page.keyboard.press("Enter");
    await expect(page.locator("h1")).toHaveText("B");
    expect(await sameDocument(page)).toBe("first document");
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  test("carries an island across only with the same children", async ({ page }) => {
    const disclosure = 'pracht-island[island="/src/islands/Disclosure.tsx"]';
    await page.goto(`${origin}/lab/slot1`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 11");
    await page.evaluate((selector) => {
      (document.querySelector(selector) as Element & { mark?: string }).mark = "slot1";
    }, disclosure);

    // Same island, same props, the same children: carried over, the counter
    // among its children with it, still counting.
    await clickInPlace(page, "#go-slot3");
    await expect(page.locator("h1")).toHaveText("Slot3");
    expect(await sameDocument(page)).toBe("first document");
    expect(
      await page.evaluate(
        (selector) => (document.querySelector(selector) as Element & { mark?: string }).mark,
        disclosure,
      ),
    ).toBe("slot1");
    await expect(page.getByTestId("count")).toHaveText("Count: 11");
    await expect(page.locator('pracht-island[island="/src/islands/Counter.tsx"]')).toHaveCount(1);
    await page.getByTestId("increment").click();
    await expect(page.getByTestId("count")).toHaveText("Count: 12");

    // Other children: the new page's island, showing the new page's children.
    await clickInPlace(page, "#go-slot2");
    await expect(page.locator("h1")).toHaveText("Slot2");
    expect(await sameDocument(page)).toBe("first document");
    await expect(page.getByTestId("slot-text")).toHaveText("two");
    expect(
      await page.evaluate(
        (selector) => (document.querySelector(selector) as Element & { mark?: string }).mark,
        disclosure,
      ),
    ).toBeUndefined();
    await expect(page.getByTestId("count")).toHaveCount(0);
    await expect(page.locator(disclosure)).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "Shared" }).click();
    await expect(page.getByTestId("slot-text")).toHaveCount(0);
  });

  test("shows the right page for entries an earlier document made", async ({ page }) => {
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await clickInPlace(page, "#go-b");
    await expect(page.locator("h1")).toHaveText("B");

    // After a reload, the entry the swap left behind belongs to no live
    // document; going back to it shows its page, not just its address.
    await page.reload();
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "reloaded"));
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/lab/a`);
    await expect(page.locator("h1")).toHaveText("A");
    await expect(page).toHaveTitle("A");
    expect(await sameDocument(page)).toBe("reloaded");
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("B");
    expect(await sameDocument(page)).toBe("reloaded");

    // Such an entry for a page that cannot be swapped is loaded.
    await page.evaluate(() => {
      history.pushState(null, "", "/lab-full");
      history.pushState(null, "", "/lab/b?after");
    });
    await page.reload();
    await hydrated(page);
    await page.goBack();
    await expect(page).toHaveURL(`${origin}/lab-full`);
    await expect(page.locator("h1")).toHaveText("Full");
  });

  test("never fetches what it cannot swap", async ({ page }) => {
    const requests = recordRequests(page);
    const fresh = async () => {
      await page.goto(`${origin}/lab/a`);
      await hydrated(page);
      await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
      requests.length = 0;
    };

    // A full-hydration route: one document request, its loader runs once.
    await fresh();
    await clickInPlace(page, "#go-full");
    await page.waitForSelector('html[data-pracht-hydrated="true"]');
    await expect(page.locator("#n")).toHaveCount(1);
    expect(requests.filter((r) => r.includes("/lab-full"))).toEqual(["document /lab-full"]);

    // An API route, by link and by GET form: never fetched by the bootstrap.
    await fresh();
    await clickInPlace(page, "#go-api");
    await page.waitForURL(`${origin}/api/lab-api`);
    expect(requests.filter((r) => r.includes("lab-api"))).toEqual(["document /api/lab-api"]);
    await fresh();
    await page.evaluate(() => {
      const form = document.createElement("form");
      form.action = "/api/lab-api";
      form.method = "get";
      document.body.append(form);
      form.submit();
    });
    await page.waitForURL(`${origin}/api/lab-api?`);
    expect(requests.filter((r) => r.includes("lab-api"))).toEqual(["document /api/lab-api?"]);

    // `data-pracht-reload` opts a link out.
    await fresh();
    await clickInPlace(page, "#go-b-reload");
    await expect(page.locator("h1")).toHaveText("B");
    expect(await sameDocument(page)).toBeUndefined();
    expect(requests.filter((r) => r.includes("/lab/b"))).toEqual(["document /lab/b"]);

    // Programmatic navigation to an islands page is swapped like a link.
    await fresh();
    await page.evaluate(() => location.assign("/lab/b"));
    await expect(page.locator("h1")).toHaveText("B");
    expect(await sameDocument(page)).toBe("first document");
  });

  test("follows redirects to the address that served the page", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    requests.length = 0;

    // To an islands page: swapped in once, under the final URL, so its
    // relative URLs resolve the way a page load would resolve them.
    await clickInPlace(page, "#go-redir");
    await expect(page.locator("h1")).toHaveText("Target");
    await expect(page).toHaveURL(`${origin}/lab/deep/target`);
    expect(await sameDocument(page)).toBe("first document");
    expect(await page.evaluate(() => navigation.currentEntry?.url)).toBe(
      `${origin}/lab/deep/target`,
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector<HTMLImageElement>("#relimg")!.naturalWidth),
      )
      .toBe(4);
    expect(requests.filter((r) => r.startsWith("document"))).toEqual([]);
    expect(requests.filter((r) => r.includes("/lab/redir"))).toEqual(["fetch /lab/redir"]);

    // To a full-hydration page: loaded from where the redirect ended, so the
    // one-time route that redirected is not requested twice.
    requests.length = 0;
    await clickInPlace(page, "#go-token");
    await page.waitForSelector('html[data-pracht-hydrated="true"]');
    await expect(page).toHaveURL(`${origin}/lab-full?ok=1`);
    expect(requests.filter((r) => r.includes("/lab/token"))).toEqual(["fetch /lab/token"]);
    expect(requests.filter((r) => r.includes("/lab-full"))).toEqual(["document /lab-full?ok=1"]);

    // To another origin (a login page): loaded from there, never fetched
    // through CORS, and the redirecting route is requested once.
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.route("http://sso.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>Sign in</h1>" }),
    );
    requests.length = 0;
    await clickInPlace(page, "#go-sso");
    await expect(page.locator("h1")).toHaveText("Sign in");
    await expect(page).toHaveURL("http://sso.test/login?n=1");
    expect(requests.filter((r) => /\/lab\/sso|\/login/.test(r))).toEqual([
      "fetch /lab/sso",
      "document /login?n=1",
    ]);
  });

  test("only swaps pages with the document's own policy", async ({ page, browser }) => {
    // A page with a different CSP is loaded, so its CSP applies.
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    await clickInPlace(page, "#go-csp");
    await expect(page.locator("h1")).toHaveText("CSP");
    expect(await sameDocument(page)).toBeUndefined();
    expect(await page.evaluate(() => (window as { cspBypassed?: boolean }).cspBypassed)).toBe(
      undefined,
    );

    // Middleware that changed the policy after the render: the page states
    // the policy it was really sent with, so a stricter page is loaded.
    await page.goto(`${origin}/lab/relaxed`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    await clickInPlace(page, "#go-csp");
    await expect(page.locator("h1")).toHaveText("CSP");
    expect(await sameDocument(page)).toBeUndefined();
    expect(await page.evaluate(() => (window as { cspBypassed?: boolean }).cspBypassed)).toBe(
      undefined,
    );

    // The load that replaces the soft navigation carries its state on, as the
    // original navigation would have. (What the browser then keeps for a new
    // document is its own business.)
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    const fallbackState = page.waitForEvent("console", (message) =>
      message.text().startsWith("fallback state "),
    );
    await page.evaluate(() => {
      navigation.addEventListener("navigate", (event) => {
        if (event.info === "pracht:full-load") {
          console.log(`fallback state ${JSON.stringify(event.destination.getState())}`);
        }
      });
      // A route not yet visited this session: a visited one is no longer fetched.
      navigation.navigate("/lab/deny", { state: { from: "app" } });
    });
    expect((await fallbackState).text()).toBe('fallback state {"from":"app"}');
    await expect(page.locator("h1")).toHaveText("Deny");

    // A meta CSP stays in force for a document's whole life: such a page is
    // loaded, and a document that has one never swaps.
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    await clickInPlace(page, "#go-metacsp");
    await expect(page.locator("h1")).toHaveText("MetaCSP");
    expect(await sameDocument(page)).toBeUndefined();
    await clickInPlace(page, "#go-deep-target");
    await expect(page.locator("h1")).toHaveText("Target");
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector<HTMLImageElement>("#relimg")!.naturalWidth),
      )
      .toBe(4);

    // A framed page never swaps, so a page that refuses framing is refused.
    const framer = await browser.newPage();
    await framer.route("http://victim.test/**", async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({ response: await route.fetch({ url: origin + url.pathname }) });
    });
    await framer.route("http://evil.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe src="http://victim.test/lab/a" width="800" height="400"></iframe>',
      }),
    );
    // /lab/a sends `x-frame-options: SAMEORIGIN`; let the frame load it.
    await framer.route("http://victim.test/lab/a", async (route) => {
      const response = await route.fetch({ url: `${origin}/lab/a` });
      const headers = { ...response.headers() };
      delete headers["x-frame-options"];
      await route.fulfill({ response, headers });
    });
    await framer.goto("http://evil.test/");
    const frame = framer.frames().find((f) => f.url().endsWith("/lab/a"))!;
    await frame.waitForSelector("h1");
    await frame.evaluate(() => document.getElementById("go-deny")!.click());
    await framer.waitForTimeout(1_500);
    const danger = await framer
      .frames()[1]
      ?.evaluate(() => !!document.getElementById("danger"))
      .catch(() => false);
    expect(danger).toBe(false);
    await framer.close();
  });

  test("fails closed, once per route, behind a proxy that changes policy headers", async ({
    page,
  }) => {
    // A proxy in front of the server that drops a header pracht set: the
    // policy a document really runs under can no longer be proven.
    await page.route(`${origin}/lab/**`, async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["x-frame-options"];
      await route.fulfill({ response, headers });
    });
    const requests = recordRequests(page);
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    requests.length = 0;

    await clickInPlace(page, "#go-b");
    await expect(page.locator("h1")).toHaveText("B");
    expect(await sameDocument(page)).toBeUndefined();
    expect(requests.filter((r) => r.includes("/lab/b"))).toEqual([
      "fetch /lab/b",
      "document /lab/b",
    ]);

    // Each route pays once to find out; for the rest of the tab's session it
    // loads without being fetched first.
    await hydrated(page);
    await clickInPlace(page, "#go-a");
    await expect(page.locator("h1")).toHaveText("A");
    await hydrated(page);
    requests.length = 0;
    await clickInPlace(page, "#go-b");
    await expect(page.locator("h1")).toHaveText("B");
    expect(requests.filter((r) => r.includes("/lab/b"))).toEqual(["document /lab/b"]);
    await page.unroute(`${origin}/lab/**`);
  });

  test("never fetches a page twice for its policy", async ({ page, request }) => {
    // A nonce changes with every response, so a nonce page never takes part.
    const html = await (await request.get(`${origin}/lab/nonce`)).text();
    expect(html).not.toContain('id="pracht-nav"');
    expect(html).not.toContain("data-pracht-owned");

    const requests = recordRequests(page);
    const visitNonce = async () => {
      await page.goto(`${origin}/lab/a`);
      await hydrated(page);
      requests.length = 0;
      await clickInPlace(page, "#go-nonce");
      await expect(page.locator("h1")).toHaveText("Nonce");
      return requests.filter((r) => r.includes("/lab/nonce"));
    };
    // The first visit learns from the headers alone that the policy differs…
    expect(await visitNonce()).toEqual(["fetch /lab/nonce", "document /lab/nonce"]);
    // …and the route is not fetched again this session.
    expect(await visitNonce()).toEqual(["document /lab/nonce"]);
  });

  test("loads pages with document-level meta, and leaves downloads alone", async ({ page }) => {
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    for (const [link, heading] of [
      ["#go-refresh", "Refresh"],
      ["#go-referrer", "Referrer"],
    ]) {
      await page.goto(`${origin}/lab/a`);
      await hydrated(page);
      await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
      await clickInPlace(page, link);
      await expect(page.locator("h1")).toHaveText(heading);
      expect(await sameDocument(page)).toBeUndefined();
    }

    // A file under an islands catch-all route downloads; the page and its
    // address stay as they were.
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    const download = page.waitForEvent("download");
    await clickInPlace(page, "#go-zip");
    expect((await download).suggestedFilename()).toBe("report.zip");
    await page.waitForTimeout(300);
    expect(await sameDocument(page)).toBe("first document");
    expect(page.url()).toBe(`${origin}/lab/a`);
    expect(await page.evaluate(() => navigation.currentEntry?.url)).toBe(`${origin}/lab/a`);
  });

  test("puts the address back before a download where it cannot wait to commit", async ({
    page,
  }) => {
    // A browser without `precommitHandler` commits the address at once.
    await page.addInitScript(() => {
      delete (globalThis as { NavigationPrecommitController?: unknown })
        .NavigationPrecommitController;
    });
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    const download = page.waitForEvent("download");
    await clickInPlace(page, "#go-zip");
    await download;
    await page.waitForTimeout(300);
    expect(await sameDocument(page)).toBe("first document");
    expect(await page.evaluate(() => navigation.currentEntry?.url)).toBe(`${origin}/lab/a`);
  });

  test("stays out of the way where it cannot work", async ({ page }) => {
    const requests = recordRequests(page);

    // Trusted Types that refuse string HTML: plain navigation, nothing fetched.
    await page.goto(`${origin}/lab/tt`);
    await page.waitForLoadState();
    requests.length = 0;
    await clickInPlace(page, "#go-tt2");
    await expect(page.locator("h1")).toHaveText("TT2");
    expect(requests.filter((r) => r.includes("/lab/tt2"))).toEqual(["document /lab/tt2"]);

    // A segment the server could not decode matches no route (checked against
    // the built bootstrap, where a minifier once dropped the decode).
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    requests.length = 0;
    await clickInPlace(page, "#go-undecodable");
    await page.waitForURL(`${origin}/lab/p/%E0%A4%A`);
    expect(requests.filter((r) => r.includes("/lab/p/"))).toEqual(["document /lab/p/%E0%A4%A"]);
  });

  test("reproduces what a page load would", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto(`${origin}/lab/a`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));

    // `<noscript>` stays inert.
    requests.length = 0;
    await clickInPlace(page, "#go-noscript");
    await expect(page.locator("h1")).toHaveText("Noscript");
    await page.waitForTimeout(300);
    expect(await sameDocument(page)).toBe("first document");
    expect(requests.filter((r) => /lab-pixel|lab-nojs/.test(r))).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
      "rgb(255, 0, 0)",
    );

    // Head scripts run in order, an external script once per document.
    await clickInPlace(page, "#go-scripts");
    await expect(page.locator("h1")).toHaveText("Scripts");
    await expect
      .poll(() => page.evaluate(() => (window as { inlineRuns?: number }).inlineRuns))
      .toBe(1);
    expect(
      await page.evaluate(() => (window as { libSeenByInline?: boolean }).libSeenByInline),
    ).toBe(true);
    await clickInPlace(page, "#go-a");
    await expect(page.locator("h1")).toHaveText("A");
    await clickInPlace(page, "#go-scripts");
    await expect(page.locator("h1")).toHaveText("Scripts");
    await expect
      .poll(() => page.evaluate(() => (window as { inlineRuns?: number }).inlineRuns))
      .toBe(2);
    expect(await page.evaluate(() => (window as { libRuns?: number }).libRuns)).toBe(1);

    // A new stylesheet does not restyle the page that is leaving.
    await clickInPlace(page, "#go-a");
    await expect(page.locator("h1")).toHaveText("A");
    const before = await page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color);
    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = ((update: () => void) => {
        (window as { atCapture?: string }).atCapture = getComputedStyle(
          document.querySelector("h1")!,
        ).color;
        return start(update);
      }) as typeof document.startViewTransition;
    });
    await clickInPlace(page, "#go-colored");
    await expect(page.locator("h1")).toHaveText("Colored");
    expect(await page.evaluate(() => (window as { atCapture?: string }).atCapture)).toBe(before);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color)).toBe(
      "rgb(200, 0, 0)",
    );

    // Shared stylesheets in another order would cascade differently after a
    // swap, so that page is loaded.
    await page.goto(`${origin}/lab/css1`);
    await hydrated(page);
    await page.evaluate(() => ((window as { marker?: string }).marker = "first document"));
    await clickInPlace(page, "#go-css2");
    await expect(page.locator("h1")).toHaveText("Css2");
    expect(await sameDocument(page)).toBeUndefined();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("h1")!).color)).toBe(
      "rgb(0, 0, 255)",
    );
  });
});

function recordDocuments(page: Page): string[] {
  const documents: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
  });
  return documents;
}

function recordRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    requests.push(
      `${request.resourceType()} ${url.pathname}${url.search || (url.href.endsWith("?") ? "?" : "")}`,
    );
  });
  return requests;
}

/** Click without Playwright scrolling the link into view first. */
async function clickInPlace(page: Page, selector: string): Promise<void> {
  await page.evaluate((s) => document.querySelector<HTMLElement>(s)!.click(), selector);
}

function hydrated(page: Page) {
  return page.waitForSelector('html[data-pracht-islands-hydrated="true"]', { state: "attached" });
}

function sameDocument(page: Page) {
  return page.evaluate(() => (window as { marker?: string }).marker);
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveDone) => {
    child.once("exit", () => resolveDone());
    setTimeout(() => resolveDone(), 5_000);
  });
}
