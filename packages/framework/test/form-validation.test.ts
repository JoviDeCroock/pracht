// @vitest-environment jsdom
import { h, render } from "preact";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Form, type ApiValidationIssue } from "../src/index.ts";

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
