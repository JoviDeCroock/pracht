import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";

import { searchDocs } from "../server/docs-index.ts";
import { docsIndex } from "../server/docs-runtime.ts";

interface SearchInput {
  query: string;
  limit: number;
}

export default defineCapability({
  title: "Search the pracht docs",
  description:
    "Full-text search over the pracht framework documentation at https://pracht.resynapse.dev. Returns the best-matching page sections, each with its page path, section anchor, URL, and a snippet. Pass a result's `page` and `section` to docs_read for the full text.",
  input: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Words to look for, e.g. `remote mcp oauth` or `defineApp agents`.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 8,
        description: "Maximum number of results.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "string", description: "Page path, e.g. /docs/capabilities." },
            section: {
              type: "string",
              description: "Heading anchor on that page; empty for the page introduction.",
            },
            title: { type: "string" },
            heading: { type: "string" },
            url: { type: "string" },
            snippet: { type: "string" },
            score: { type: "integer" },
          },
          required: ["page", "section", "title", "heading", "url", "snippet", "score"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  },
  effect: "read",
  expose: { mcp: true },
  async run({ input }: CapabilityRunArgs<SearchInput>) {
    return { results: searchDocs(await docsIndex(), input.query, input.limit) };
  },
});
