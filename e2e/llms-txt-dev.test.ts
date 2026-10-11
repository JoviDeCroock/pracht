import { expect, test } from "@playwright/test";

// Runs against the pages-router example dev server, which enables the
// vite plugin's `llmsTxt` option (see examples/pages-router/vite.config.ts).

test("GET /llms.txt serves the generated llms.txt in dev", async ({ request }) => {
  const response = await request.get("/llms.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");

  const body = await response.text();
  expect(body.startsWith("# Pracht Pages Example\n")).toBe(true);
  expect(body).toContain("## Pages");
  expect(body).toContain("- [/](/)");
  // `/about` exports `markdown`, but the root `_middleware.ts` runs on every
  // page, so it negotiates per request and has no `.md` file.
  expect(body).toContain("- [/about](/about): supports `Accept: text/markdown`");

  // Dynamic SSG routes are expanded through getStaticPaths(); the raw
  // pattern must not appear.
  expect(body).toContain("- [/blog/getting-started](/blog/getting-started)");
  expect(body).toContain("- [/blog/hello-world](/blog/hello-world)");
  expect(body).not.toContain("/blog/:slug");

  expect(body).toContain("## API");
  expect(body).toContain("- [/api/health](/api/health): GET");
  expect(body).toContain("- [/api/me](/api/me): GET");
});

test("llms.txt page ordering is stable", async ({ request }) => {
  const body = await (await request.get("/llms.txt")).text();
  const paths = body.split("\n").flatMap((line) => {
    const match = line.match(/^- \[([^\]]+)\]/);
    return match && !match[1].startsWith("/api") ? [match[1]] : [];
  });

  const sorted = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  expect(paths.length).toBeGreaterThan(3);
  expect(paths).toEqual(sorted);
});

test("GET /<page>.md has no Markdown for pages without a file", async ({ request }) => {
  // Pages without a file in the build have no `.md` URL here either (`/about`
  // has middleware, `/pricing` is ISG); the app answers with its own 404
  // rather than the dev server's bare one.
  for (const path of ["/about.md", "/pricing.md", "/nope.md"]) {
    const missing = await request.get(path);
    expect(missing.status()).toBe(404);
    expect(await missing.text()).not.toContain("Cannot GET");
  }

  // A URL a dynamic route matches is that route's, as in production.
  const dynamic = await request.get("/blog/hello-world.md");
  expect(dynamic.headers()["content-type"]).not.toContain("text/markdown");
});
