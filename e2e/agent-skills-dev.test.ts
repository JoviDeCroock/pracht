import { expect, test } from "@playwright/test";

test("Agent Skills discovery and Markdown assets are served live in dev", async ({ request }) => {
  const indexResponse = await request.get("/.well-known/agent-skills/index.json");
  expect(indexResponse.status()).toBe(200);
  expect(indexResponse.headers()["content-type"]).toContain("application/json");
  expect(indexResponse.headers()["access-control-allow-origin"]).toBe("*");
  const index = await indexResponse.json();
  expect(index.name).toBe("pracht-cloudflare");
  expect(index.skills).toEqual([
    expect.objectContaining({
      name: "pracht-example",
      type: "skill-md",
      url: "/skills/pracht-example/SKILL.md",
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }),
  ]);

  const skillResponse = await request.get("/skills/pracht-example/SKILL.md");
  expect(skillResponse.status()).toBe(200);
  expect(skillResponse.headers()["content-type"]).toContain("text/markdown");
  expect(skillResponse.headers()["access-control-allow-origin"]).toBe("*");
  expect(await skillResponse.text()).toContain("# Pracht Cloudflare Example");

  const headResponse = await request.head("/skills/pracht-example/SKILL.md");
  expect(headResponse.status()).toBe(200);
  expect(await headResponse.body()).toHaveLength(0);

  const homeResponse = await request.get("/");
  expect(homeResponse.headers()["link"]).toContain(
    '</.well-known/agent-skills/index.json>; rel="agent-skills"',
  );
});
