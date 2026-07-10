import { defineCapability } from "@pracht/capabilities";
import { purgeNotes } from "../server/notes-store.ts";

interface PurgeInput {
  titlePrefix: string;
}

// Destructive demo capability: exposed over HTTP, which means every dispatch
// goes through the server-verified prepare/commit confirmation flow — the
// first call answers 409 confirmation_required with a token, and only a
// second call with identical input plus the x-pracht-confirm header runs.
// Requires PRACHT_CONFIRMATION_SECRET in the environment.
export default defineCapability<PurgeInput>({
  title: "Purge notes",
  description: "Permanently delete every note whose title starts with the prefix.",
  input: {
    type: "object",
    properties: {
      titlePrefix: { type: "string", minLength: 3 },
    },
    required: ["titlePrefix"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      purged: { type: "integer", minimum: 0 },
    },
    required: ["purged"],
  },
  effect: "destructive",
  expose: {
    http: true,
  },
  async run({ input }) {
    return { purged: purgeNotes(input.titlePrefix) };
  },
});
