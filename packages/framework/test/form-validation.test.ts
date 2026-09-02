// @vitest-environment jsdom
import { h, render } from "preact";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_FORM_REDIRECT_HEADER,
  CAPABILITY_FORM_REQUEST_HEADER,
  CAPABILITY_SETTLED_EVENT,
} from "../../capabilities/src/index.ts";
import { Form, type ApiValidationIssue, type HttpCapabilityName } from "../src/index.ts";
import {
  _resetNavigationForTesting,
  getNavigation,
  subscribeToNavigation,
} from "../src/navigation-state.ts";

/**
 * `<Form capability>` only accepts http-exposed capability names an app has
 * registered via `pracht typegen`. These are framework tests: they must behave
 * the same whatever `Register` the surrounding typecheck happens to see, so
 * they use names no app registers and opt out of that check deliberately. The
 * names here are incidental — what is under test is the submit pipeline.
 */
const unregistered = (name: string) => name as HttpCapabilityName;

const nameSchema: StandardSchemaV1<Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "pracht-test",
    validate(value) {
      const name = (value as Record<string, unknown>).name;
      if (typeof name !== "string" || name.length === 0) {
        return { issues: [{ message: "Name is required", path: ["name"] }] };
      }
      return { value: value as Record<string, unknown> };
    },
  },
};

const actionSchema: StandardSchemaV1<Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "pracht-test",
    validate(value) {
      const action = (value as Record<string, unknown>).action;
      return action === "save"
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "Action is required", path: ["action"] }] };
    },
  },
};

describe("<Form> validation", () => {
  let root: HTMLDivElement;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    delete window.__PRACHT_NAVIGATE__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function submit(): Promise<void> {
    const form = root.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("skips the request and reports issues when the schema rejects", async () => {
    const issues: ApiValidationIssue[][] = [];

    render(
      h(
        Form,
        {
          action: "/api/items",
          method: "post",
          schema: nameSchema,
          onValidationIssues: (found) => issues.push(found),
        },
        h("input", { name: "name", value: "" }),
      ),
      root,
    );

    await submit();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(issues).toEqual([[{ in: "body", message: "Name is required", path: ["name"] }]]);
  });

  it("prevents invalid native GET submissions", async () => {
    const issues: ApiValidationIssue[][] = [];

    render(
      h(
        Form,
        {
          action: "/search",
          method: "get",
          schema: nameSchema,
          onValidationIssues: (found) => issues.push(found),
        },
        h("input", { name: "name", value: "" }),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.defaultPrevented).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(issues).toEqual([[{ in: "body", message: "Name is required", path: ["name"] }]]);
  });

  it("resumes valid native GET submissions after validation", async () => {
    const requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => undefined);

    render(
      h(
        Form,
        { action: "/search", method: "get", schema: nameSchema },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits when the schema accepts the form data", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    const onValidationIssues = vi.fn();

    render(
      h(
        Form,
        { action: "/api/items", method: "post", schema: nameSchema, onValidationIssues },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onValidationIssues).not.toHaveBeenCalled();
  });

  it("validates and submits the clicked button value", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));
    const onValidationIssues = vi.fn();

    render(
      h(
        Form,
        {
          action: "/api/items",
          method: "post",
          schema: actionSchema,
          onValidationIssues,
        },
        h("button", { name: "action", value: "save" }, "Save"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    form.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onValidationIssues).not.toHaveBeenCalled();
    const body = fetchSpy.mock.calls[0][1].body as FormData;
    expect(body.get("action")).toBe("save");
  });

  it("validates capability forms before submitting", async () => {
    const issues: ApiValidationIssue[][] = [];

    render(
      h(
        Form,
        {
          capability: unregistered("items.create"),
          schema: nameSchema,
          onValidationIssues: (found) => issues.push(found),
        },
        h("input", { name: "name", value: "" }),
      ),
      root,
    );

    await submit();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(issues).toEqual([[{ in: "body", message: "Name is required", path: ["name"] }]]);
  });

  it("includes the clicked button value in capability submissions", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        headers: { "content-type": "application/json" },
      }),
    );

    render(
      h(
        Form,
        { capability: unregistered("items.save") },
        h("button", { name: "action", value: "save" }, "Save"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    form.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const body = fetchSpy.mock.calls[0][1].body as FormData;
    expect(body.get("action")).toBe("save");
  });

  it("keeps capability response bodies readable in onResponse", async () => {
    const responseBody = { ok: true, data: { created: "pracht" } };
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const responses: Response[] = [];

    render(
      h(
        Form,
        {
          capability: unregistered("items.create"),
          onResponse: (response) => responses.push(response),
        },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(201);
    await expect(responses[0].json()).resolves.toEqual(responseBody);
  });

  it("dispatches the server-provided effect for capability revalidation", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        headers: {
          "content-type": "application/json",
          [CAPABILITY_EFFECT_HEADER]: "read",
        },
      }),
    );
    const settled = vi.fn();
    window.addEventListener(CAPABILITY_SETTLED_EVENT, settled, { once: true });

    render(h(Form, { capability: unregistered("items.search") }), root);
    await submit();

    expect(settled).toHaveBeenCalledTimes(1);
    expect((settled.mock.calls[0][0] as CustomEvent).detail).toEqual({
      name: "items.search",
      ok: true,
      effect: "read",
    });
  });

  it("uses the clicked button's formaction for capability submissions", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        headers: { "content-type": "application/json" },
      }),
    );

    render(
      h(
        Form,
        { capability: unregistered("items.save") },
        h("button", { formAction: "/api/capabilities/items/alternate" }, "Save elsewhere"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    form.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/capabilities/items/alternate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("navigates capability middleware redirects", async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: {
          [CAPABILITY_FORM_REDIRECT_HEADER]: "/login?returnTo=%2Fnotes",
        },
      }),
    );
    const navigate = vi.fn(async () => undefined);
    window.__PRACHT_NAVIGATE__ = navigate;
    const results = vi.fn();

    render(h(Form, { capability: unregistered("items.save"), onCapabilityResult: results }), root);
    await submit();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/capabilities/items/save",
      expect.objectContaining({
        headers: { [CAPABILITY_FORM_REQUEST_HEADER]: "1" },
      }),
    );
    expect(navigate).toHaveBeenCalledWith("/login?returnTo=%2Fnotes", {
      _reloadRouteState: true,
      replace: undefined,
    });
    expect(results).not.toHaveBeenCalled();
  });

  it("leaves cross-origin capability targets to native form navigation", async () => {
    render(
      h(
        Form,
        { capability: unregistered("items.save") },
        h("button", { formAction: "https://auth.example/login" }, "Sign in"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    const event = new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter: button,
    });
    form.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // A cross-origin capability submission ends as a document navigation, so it
  // must never publish pending state: settling it as `requestSubmit()` starts
  // that navigation re-enables a button gated on `useNavigation()` while the
  // page is already leaving.
  it("never enters submitting state for a cross-origin capability target", async () => {
    const requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => undefined);
    _resetNavigationForTesting();
    const states: string[] = [];
    const unsubscribe = subscribeToNavigation((navigation) => states.push(navigation.state));

    render(
      h(
        Form,
        { capability: unregistered("items.save"), schema: nameSchema },
        h("input", { name: "name", value: "pracht" }),
        h("button", { formAction: "https://auth.example/login" }, "Sign in"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    form.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(getNavigation().state).toBe("idle");
  });

  it("blocks unsafe capability form targets", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      h(
        Form,
        { capability: unregistered("items.save") },
        h("button", { formAction: "javascript:alert(1)" }, "Run"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    const event = new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter: button,
    });
    form.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.defaultPrevented).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("unsafe URL"));
  });

  it("uses the clicked button's formaction for enhanced submissions", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    render(
      h(
        Form,
        { action: "/api/default", method: "post" },
        h("button", { formAction: "/api/alternate" }, "Save elsewhere"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    form.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/alternate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("leaves cross-origin action targets to native form navigation", async () => {
    render(
      h(
        Form,
        { action: "https://auth.example/login", method: "post" },
        h("input", { name: "returnTo", value: "/dashboard" }),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates cross-origin action targets before native form navigation", async () => {
    const requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => undefined);

    render(
      h(
        Form,
        { action: "https://auth.example/login", method: "post", schema: nameSchema },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets a clicked button's safe formmethod use native submission", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    render(
      h(
        Form,
        { action: "/api/items", method: "post" },
        h("button", { formMethod: "get" }, "Preview"),
      ),
      root,
    );

    const form = root.querySelector("form")!;
    const button = root.querySelector("button")!;
    const event = new SubmitEvent("submit", {
      bubbles: true,
      cancelable: true,
      submitter: button,
    });
    form.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(event.defaultPrevented).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces server-side 422 validation issues", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation",
          issues: [{ in: "body", message: "Name is taken", path: ["name"] }],
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    const issues: ApiValidationIssue[][] = [];

    render(
      h(
        Form,
        {
          action: "/api/items",
          method: "post",
          onValidationIssues: (found) => issues.push(found),
        },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(issues).toEqual([[{ in: "body", message: "Name is taken", path: ["name"] }]]);
  });

  it("surfaces server-side 400 validation issues", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation",
          issues: [{ in: "body", message: "Malformed form body" }],
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    const issues: ApiValidationIssue[][] = [];

    render(
      h(
        Form,
        {
          action: "/api/items",
          method: "post",
          onValidationIssues: (found) => issues.push(found),
        },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(issues).toEqual([[{ in: "body", message: "Malformed form body" }]]);
  });

  it("hands non-redirect responses to onResponse", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ created: "pracht" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const responses: Response[] = [];

    render(
      h(
        Form,
        { action: "/api/items", method: "post", onResponse: (found) => responses.push(found) },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(201);
    await expect(responses[0].json()).resolves.toEqual({ created: "pracht" });
  });

  it("navigates to an API redirect without fetching the destination first", async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { [CAPABILITY_FORM_REDIRECT_HEADER]: "/greeting" },
      }),
    );
    const navigate = vi.fn(async () => undefined);
    window.__PRACHT_NAVIGATE__ = navigate;
    const responses: Response[] = [];

    render(
      h(
        Form,
        { action: "/api/locale", method: "post", onResponse: (found) => responses.push(found) },
        h("input", { name: "locale", value: "nl" }),
      ),
      root,
    );

    await submit();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/locale",
      expect.objectContaining({
        method: "POST",
        headers: { [CAPABILITY_FORM_REQUEST_HEADER]: "1" },
      }),
    );
    // Same-origin targets are normalized to a path before navigating.
    expect(navigate).toHaveBeenCalledWith("/greeting", {
      _reloadRouteState: true,
      replace: undefined,
    });
    expect(responses).toHaveLength(0);
  });

  it("still reads the Location header from an unfollowed redirect", async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, { status: 303, headers: { location: "/greeting" } }),
    );
    const navigate = vi.fn(async () => undefined);
    window.__PRACHT_NAVIGATE__ = navigate;

    render(
      h(
        Form,
        { action: "/api/locale", method: "post" },
        h("input", { name: "locale", value: "nl" }),
      ),
      root,
    );

    await submit();

    expect(navigate).toHaveBeenCalledWith("/greeting", {
      _reloadRouteState: true,
      replace: undefined,
    });
  });

  it("keeps the response body readable in onResponse after issues are parsed", async () => {
    const errorBody = {
      error: "validation",
      issues: [{ in: "body", message: "Name is taken", path: ["name"] }],
    };
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(errorBody), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    const issues: ApiValidationIssue[][] = [];
    const responses: Response[] = [];

    render(
      h(
        Form,
        {
          action: "/api/items",
          method: "post",
          onValidationIssues: (found) => issues.push(found),
          onResponse: (found) => responses.push(found),
        },
        h("input", { name: "name", value: "pracht" }),
      ),
      root,
    );

    await submit();

    expect(issues).toEqual([errorBody.issues]);
    expect(responses).toHaveLength(1);
    await expect(responses[0].json()).resolves.toEqual(errorBody);
  });
});
