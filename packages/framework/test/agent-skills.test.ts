import { describe, expect, it } from "vitest";

import { applyAgentSkillsHeaders, defineApp, handlePrachtRequest } from "../src/index.ts";

const agents = {
  skills: {
    directory: "./skills",
    manifest: { name: "example" },
    advertise: true,
  },
} as const;

describe("Agent Skills response headers", () => {
  it("advertises discovery without replacing application Link values", async () => {
    const app = defineApp({ agents, routes: [] });
    const response = await handlePrachtRequest({
      app,
      request: new Request("https://example.com/missing"),
    });

    expect(response.headers.get("link")).toBe(
      '</.well-known/agent-skills/index.json>; rel="agent-skills"',
    );

    const headers = new Headers({ link: '</sitemap.xml>; rel="sitemap"' });
    applyAgentSkillsHeaders(headers, agents);
    expect(headers.get("link")).toBe(
      '</sitemap.xml>; rel="sitemap", </.well-known/agent-skills/index.json>; rel="agent-skills"',
    );
  });

  it("sets explicit MIME and CORS headers only on generated assets", () => {
    const indexHeaders = applyAgentSkillsHeaders(
      new Headers(),
      agents,
      "/.well-known/agent-skills/index.json",
    );
    expect(indexHeaders.get("content-type")).toBe("application/json; charset=utf-8");
    expect(indexHeaders.get("access-control-allow-origin")).toBe("*");

    const skillHeaders = applyAgentSkillsHeaders(
      new Headers(),
      agents,
      "/skills/review-code/SKILL.md",
    );
    expect(skillHeaders.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(skillHeaders.get("access-control-allow-origin")).toBe("*");
  });
});
