import { defineCapability } from "@pracht/capabilities";

import { NAV } from "../shells/docs.tsx";
import { listDocs } from "../server/docs-index.ts";
import { docsIndex } from "../server/docs-runtime.ts";

export default defineCapability({
  title: "List the pracht docs pages",
  description:
    "The table of contents of the pracht documentation: every page with its path, title, URL, and one-line summary, grouped like the site navigation.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            pages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  page: { type: "string" },
                  title: { type: "string" },
                  lead: { type: "string" },
                  url: { type: "string" },
                },
                required: ["page", "title", "lead", "url"],
                additionalProperties: false,
              },
            },
          },
          required: ["label", "pages"],
          additionalProperties: false,
        },
      },
    },
    required: ["groups"],
    additionalProperties: false,
  },
  effect: "read",
  expose: { mcp: true },
  async run() {
    return { groups: listDocs(await docsIndex(), NAV) };
  },
});
