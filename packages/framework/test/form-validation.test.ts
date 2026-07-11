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
});
