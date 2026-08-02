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
