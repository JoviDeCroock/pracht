// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { createFormRequest, submitForm } from "../src/index.ts";

describe("form helpers in JSDOM", () => {
  it("serializes urlencoded fields without crossing DOM realms", async () => {
    const request = await createFormRequest({ name: "Alice", tag: ["a", "b"] });

    expect(request.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const body = new URLSearchParams(await request.text());
    expect(body.get("name")).toBe("Alice");
    expect(body.getAll("tag")).toEqual(["a", "b"]);
  });

  it("serializes a JSDOM File for Node's Request implementation", async () => {
    const response = await submitForm(
      async ({ request }) => {
        const form = await request.formData();
        const upload = form.get("upload") as Blob & { name?: string };
        return Response.json({
          name: upload.name,
          type: upload.type,
          contents: await upload.text(),
        });
      },
      {
        title: "Document",
        upload: new File(["hello"], "hello.txt", { type: "text/plain" }),
      },
    );

    expect(await response.json()).toEqual({
      name: "hello.txt",
      type: "text/plain",
      contents: "hello",
    });
  });
});
