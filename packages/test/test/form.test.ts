import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ApiRouteArgs, ApiValidationErrorBody } from "@pracht/core";
import { defineApi } from "@pracht/core";
import { describe, expect, it } from "vitest";

import { createFormRequest, readJson, submitForm } from "../src/index.ts";

/** Minimal Standard Schema: every listed field must be a non-empty string. */
function requiredStrings<TField extends string>(
  ...fields: TField[]
): StandardSchemaV1<Record<string, unknown>, Record<TField, string>> {
  return {
    "~standard": {
      version: 1,
      vendor: "pracht-test",
      validate(value) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "Expected an object" }] };
        }
        const record = value as Record<string, unknown>;
        const issues = fields.flatMap((field) =>
          typeof record[field] === "string" && record[field] !== ""
            ? []
            : [{ message: "Required", path: [field] }],
        );
        return issues.length > 0 ? { issues } : { value: record as Record<TField, string> };
      },
    },
  };
}

describe("createFormRequest", () => {
  it("builds an urlencoded POST by default", async () => {
    const request = createFormRequest({ name: "Alice", count: 2, subscribed: true });

    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const body = await request.text();
    expect(new URLSearchParams(body).get("name")).toBe("Alice");
    expect(new URLSearchParams(body).get("count")).toBe("2");
    expect(new URLSearchParams(body).get("subscribed")).toBe("true");
  });

  it("switches to multipart when a field is a File", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const request = createFormRequest({ title: "doc", attachment: file });

    expect(request.headers.get("content-type")).toContain("multipart/form-data");
    const form = await request.formData();
    expect(form.get("title")).toBe("doc");
    expect(form.get("attachment")).toBeInstanceOf(File);
  });

  it("repeats entries for array fields", async () => {
    const request = createFormRequest({ tag: ["a", "b"] });
    const body = new URLSearchParams(await request.text());
    expect(body.getAll("tag")).toEqual(["a", "b"]);
  });

  it("refuses File fields with explicit urlencoded encoding", () => {
    const file = new File(["x"], "x.txt");
    expect(() => createFormRequest({ file }, { encoding: "urlencoded" })).toThrow(
      /cannot be sent as "urlencoded"/,
    );
  });
});

describe("submitForm", () => {
  const POST = defineApi({
    body: requiredStrings("name", "email"),
    handler: ({ body }) => ({ ok: true, name: body.name, email: body.email }),
  });

  it("drives a defineApi handler through its form parsing path", async () => {
    const response = await submitForm(POST, {
      name: "Alice",
      email: "alice@example.com",
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ok: true,
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("surfaces the standardized 422 validation body for invalid fields", async () => {
    const response = await submitForm(POST, { name: "Alice", email: "" });

    expect(response.status).toBe(422);
    const body = await readJson<ApiValidationErrorBody>(response);
    expect(body.error).toBe("validation");
    expect(body.issues).toEqual([{ in: "body", message: "Required", path: ["email"] }]);
  });

  it("submits multipart to a plain handler that reads formData()", async () => {
    async function handler({ request }: ApiRouteArgs<Record<string, never>>) {
      const form = await request.formData();
      const file = form.get("upload");
      if (!(file instanceof File)) return new Response("missing file", { status: 400 });
      return Response.json({ filename: file.name, contents: await file.text() });
    }

    const response = await submitForm(handler, {
      upload: new File(["file body"], "notes.txt", { type: "text/plain" }),
    });

    expect(await readJson(response)).toEqual({ filename: "notes.txt", contents: "file body" });
  });

  it("passes url, params, and context through to the handler args", async () => {
    async function handler({ url, params, context }: ApiRouteArgs<{ role: string }>) {
      return Response.json({ path: url.pathname, id: params.id, role: context.role });
    }

    const response = await submitForm<{ role: string }>(
      handler,
      { any: "field" },
      {
        url: "/api/users/42",
        params: { id: "42" },
        context: { role: "admin" },
      },
    );

    expect(await readJson(response)).toEqual({ path: "/api/users/42", id: "42", role: "admin" });
  });
});
