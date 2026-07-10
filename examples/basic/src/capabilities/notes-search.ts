import { defineCapability } from "@pracht/capabilities";
import { searchNotes } from "../server/notes-store.ts";

interface SearchInput {
  query: string;
  limit: number;
}

export default defineCapability<SearchInput>({
  title: "Search notes",
  description: "Find notes whose title or body matches the query.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Text to search for." },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      notes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["id", "title", "body"],
        },
      },
    },
    required: ["notes"],
  },
  effect: "read",
  expose: {
    http: true,
    webmcp: true,
  },
  async run({ input }) {
    return { notes: searchNotes(input.query, input.limit) };
  },
});
