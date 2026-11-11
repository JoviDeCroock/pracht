import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import { createNote } from "../server/notes-store.ts";
import { invalidNoteForm } from "../server/note-form.tsx";

interface CreateInput {
  title: string;
  body: string;
}

export default defineCapability({
  title: "Create note",
  description: "Add a new note with a title and body.",
  input: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 120 },
      body: { type: "string", default: "" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      note: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["id", "title", "body"],
      },
    },
    required: ["note"],
  },
  effect: "write",
  expose: {
    http: true,
    mcp: true,
  },
  form: { retain: ["title", "body"], redirectTo: "/notes", onInvalid: invalidNoteForm },
  async run({ input }: CapabilityRunArgs<CreateInput>) {
    return { note: createNote(input.title, input.body) };
  },
});
