import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";

import { readDoc } from "../server/docs-index.ts";
import { docsIndex } from "../server/docs-runtime.ts";

interface ReadInput {
  page: string;
  section?: string;
}

export default defineCapability({
  title: "Read a pracht docs page",
  description:
    "Return one page of the pracht documentation as Markdown, or only one section of it. `page` accepts a path (/docs/capabilities), a slug (capabilities, recipes/auth), or a page URL. `sections` lists the page's anchors. An unknown page or section answers found: false with the closest matches.",
  input: {
    type: "object",
    properties: {
      page: {
        type: "string",
        minLength: 1,
        maxLength: 300,
        description: "Page path, slug, or URL, e.g. /docs/capabilities.",
      },
      section: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description:
          "Heading anchor from docs_search or `sections`, e.g. remote-mcp-tools-for-agents-without-a-browser.",
      },
    },
    required: ["page"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      page: { type: "string" },
      section: { type: "string" },
      title: { type: "string" },
      url: { type: "string" },
      markdown: { type: "string" },
      truncated: { type: "boolean" },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section: { type: "string" },
            heading: { type: "string" },
            depth: { type: "integer" },
          },
          required: ["section", "heading", "depth"],
          additionalProperties: false,
        },
      },
      message: { type: "string" },
      suggestions: { type: "array", items: { type: "string" } },
    },
    required: [
      "found",
      "page",
      "section",
      "title",
      "url",
      "markdown",
      "truncated",
      "sections",
      "message",
      "suggestions",
    ],
    additionalProperties: false,
  },
  effect: "read",
  expose: { mcp: true },
  async run({ input }: CapabilityRunArgs<ReadInput>) {
    return readDoc(await docsIndex(), input.page, input.section);
  },
});
