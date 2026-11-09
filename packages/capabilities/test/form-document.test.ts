import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";

import {
  defineCapability,
  CAPABILITY_FORM_REQUEST_HEADER,
  type CapabilityFormOptions,
} from "../src/index.ts";
import { createCapabilityHost } from "../src/server/index.ts";

const ORIGIN = "https://app.example";

function fixture(form?: Omit<CapabilityFormOptions, "redirectTo">) {
  const run = vi.fn(() => ({ saved: true }));
  const host = createCapabilityHost({
    capabilities: {
      "profile.save": defineCapability({
        title: "Save profile",
        description: "Update a public display name.",
        effect: "write",
        input: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 3 },
            password: { type: "string", minLength: 4 },
          },
          required: ["title", "password"],
          additionalProperties: false,
        },
        output: { type: "object", properties: { saved: { type: "boolean" } }, required: ["saved"] },
        expose: { http: true, mcp: true },
        form: form ? { redirectTo: "/profile", ...form } : undefined,
        run,
      }),
    },
    agents: { mcp: {} },
  });
  return { host, run };
}

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/capabilities/profile/save`, {
    method: "POST",
    body,
    headers: {
      accept: "text/html",
      origin: ORIGIN,
      referer: `${ORIGIN}/profile`,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
  });
}

describe("native capability form failures", () => {
  it.each([
    "https://external.example/",
    "//external.example/",
    "/\\external.example/",
    "/profile?next=elsewhere",
    "/profile#edit",
    "/a/../profile",
  ])("rejects a non-local or normalized success target %s", (redirectTo) => {
    expect(() =>
      fixture({ redirectTo, onInvalid: () => new Response() } as CapabilityFormOptions),
    ).toThrow(/same-origin redirectTo pathname/);
  });
  it("renders field errors, retains selected text, and accepts a corrected retry", async () => {
    const onInvalid = vi.fn<CapabilityFormOptions["onInvalid"]>(
      ({ feedback }) =>
        new Response(
          renderToString(
            h(
              "html",
              { lang: "en" },
              h(
                "body",
                {},
                h("h1", {}, "Check your profile"),
                h(
                  "form",
                  { action: "/api/capabilities/profile/save", method: "post" },
                  h("label", { for: "title" }, "Public name"),
                  h("input", {
                    id: "title",
                    name: "title",
                    value: feedback.values.title,
                    "aria-invalid": !!feedback.fieldErrors.title,
                    "aria-describedby": "title-error",
                  }),
                  h("p", { id: "title-error" }, feedback.fieldErrors.title?.join(" ")),
                  h("label", { for: "password" }, "Password"),
                  h("input", { id: "password", name: "password", type: "password" }),
                  h("p", {}, feedback.fieldErrors.password?.join(" ")),
                  h("button", { type: "submit" }, "Save profile"),
                ),
              ),
            ),
          ),
          { status: 400, headers: { "content-type": "text/html", "cache-control": "public" } },
        ),
    );
    const { host, run } = fixture({ retain: ["title"], onInvalid });
    const response = (await host.fetch(
      post(new URLSearchParams({ title: '<script>alert("name")</script>', password: "x" })),
    ))!;
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    const html = await response.text();
    expect(html).toContain("&lt;script>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('value="x"');
    expect(html).toContain("must be at least 4 character(s) long");
    expect(onInvalid.mock.calls[0]![0].feedback.values).toEqual({
      title: '<script>alert("name")</script>',
    });
    expect(run).not.toHaveBeenCalled();

    const corrected = await host.fetch(
      post(new URLSearchParams({ title: "My name", password: "new-secret" }), {
        referer: `${ORIGIN}/api/capabilities/profile/save`,
      }),
    );
    expect(corrected?.status).toBe(303);
    expect(corrected?.headers.get("location")).toBe(`${ORIGIN}/profile`);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps the existing JSON envelope without an opt-in renderer", async () => {
    const { host } = fixture();
    const response = await host.fetch(post(new URLSearchParams({ title: "x" })));
    expect(response?.headers.get("content-type")).toContain("application/json");
    expect((await response!.json()).error.code).toBe("invalid_input");
  });

  it("applies same-origin checks before invoking the renderer", async () => {
    const onInvalid = vi.fn();
    const { host } = fixture({ onInvalid });
    const response = await host.fetch(
      post(new URLSearchParams(), { origin: "https://other.example" }),
    );
    expect(response?.status).toBe(403);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("continues rejecting opaque-origin form requests", async () => {
    const onInvalid = vi.fn();
    const { host } = fixture({ onInvalid });
    const response = await host.fetch(
      post(new URLSearchParams(), {
        origin: "null",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(response?.status).toBe(403);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it.each([
    ["enhanced forms", { [CAPABILITY_FORM_REQUEST_HEADER]: "1" }],
    ["WebMCP", { "x-pracht-transport": "webmcp" }],
    ["non-document forms", { accept: "application/json" }],
  ])("keeps JSON for %s", async (_label, headers) => {
    const onInvalid = vi.fn();
    const { host } = fixture({ onInvalid });
    const response = await host.fetch(post(new URLSearchParams({ title: "x" }), headers));
    expect((await response!.json()).error.code).toBe("invalid_input");
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("keeps JSON request and MCP failures on their normal protocol", async () => {
    const onInvalid = vi.fn();
    const { host } = fixture({ onInvalid });
    const response = await host.fetch(
      post('{"title":"x"}', { "content-type": "application/json" }),
    );
    expect((await response!.json()).error.code).toBe("invalid_input");
    const mcp = await host.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "profile_save",
            arguments: { title: "x" },
          },
        }),
      }),
    );
    expect((await mcp!.json()).result.isError).toBe(true);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it.each([
    () => {
      throw new Error("renderer-secret");
    },
    () => Response.redirect("https://external.example"),
    () => Response.json({ secret: "renderer-secret" }, { status: 400 }),
  ])("redacts a failed or invalid renderer response", async (onInvalid) => {
    const { host, run } = fixture({ onInvalid });
    const response = await host.fetch(post(new URLSearchParams()));
    expect(response?.status).toBe(500);
    expect(await response?.json()).toEqual({
      ok: false,
      error: { code: "internal_error", message: "Capability failed." },
    });
    expect(run).not.toHaveBeenCalled();
  });
});
