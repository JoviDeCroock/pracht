import { describe, expect, it } from "vitest";

import { htmlResponse } from "../src/runtime-html.ts";

describe("htmlResponse", () => {
  it("sends the same body a string Response would, including non-ASCII and lone surrogates", async () => {
    const html = "<p>View → 🙂 \uD800 end</p>";

    const response = htmlResponse(html);

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(await new Response(html).arrayBuffer()),
    );
  });

  it("keeps the status and caller headers", async () => {
    const response = htmlResponse("<p>missing</p>", 404, { "x-test": "1" });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.text()).toBe("<p>missing</p>");
  });
});
