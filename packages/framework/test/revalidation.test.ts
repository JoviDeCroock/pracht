import { describe, expect, it } from "vitest";

import {
  getTimeRevalidateSeconds,
  hasWebhookRevalidate,
  isAuthorizedRevalidationRequest,
  normalizeRouteRevalidate,
  readRevalidationRequest,
  timeRevalidate,
  webhookRevalidate,
} from "@pracht/core";

describe("revalidation policies", () => {
  it("supports combining time and webhook revalidation", () => {
    const policy = [timeRevalidate(60), webhookRevalidate()] as const;

    expect(normalizeRouteRevalidate(policy)).toEqual([
      { kind: "time", seconds: 60 },
      { kind: "webhook" },
    ]);
    expect(getTimeRevalidateSeconds(policy)).toBe(60);
    expect(hasWebhookRevalidate(policy)).toBe(true);
  });

  it("rejects invalid literal policy objects", () => {
    expect(() => normalizeRouteRevalidate({ kind: "time", seconds: 0 } as never)).toThrow(
      "positive integer",
    );
    expect(() =>
      normalizeRouteRevalidate([{ kind: "webhook" }, { kind: "webhook" }] as never),
    ).toThrow('duplicate "webhook"');
    expect(() => normalizeRouteRevalidate({ kind: "cms" } as never)).toThrow(
      'Unsupported route revalidate policy "cms"',
    );
  });
});

describe("revalidation endpoint auth", () => {
  it("accepts a valid bearer token", () => {
    const request = new Request("https://app.example/__pracht/revalidate", {
      headers: { authorization: "Bearer secret" },
      method: "POST",
    });

    expect(isAuthorizedRevalidationRequest(request, "secret")).toBe(true);
  });

  it("rejects bad and missing server tokens", () => {
    const request = new Request("https://app.example/__pracht/revalidate", {
      headers: { authorization: "Bearer wrong" },
      method: "POST",
    });

    expect(isAuthorizedRevalidationRequest(request, "secret")).toBe(false);
    expect(isAuthorizedRevalidationRequest(request, undefined)).toBe(false);
    expect(isAuthorizedRevalidationRequest(request, "")).toBe(false);
  });

  it("parses paths only after authorization", async () => {
    const unauthorized = await readRevalidationRequest(
      new Request("https://app.example/__pracht/revalidate", {
        body: JSON.stringify({ paths: ["/pricing"] }),
        headers: { authorization: "Bearer wrong" },
        method: "POST",
      }),
      "secret",
    );

    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.response.status).toBe(401);

    const authorized = await readRevalidationRequest(
      new Request("https://app.example/__pracht/revalidate", {
        body: JSON.stringify({ paths: ["/pricing", "/pricing"] }),
        headers: { authorization: "Bearer secret" },
        method: "POST",
      }),
      "secret",
    );

    expect(authorized).toEqual({ ok: true, paths: ["/pricing"] });
  });
});
