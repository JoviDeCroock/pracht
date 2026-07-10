// In-memory notes backing both capabilities. Server-only — this marker must
// never appear in client bundles (asserted by e2e/client-bundle-strip.test.ts).
export const NOTES_STORE_SERVER_MARKER = "PRACHT_NOTES_STORE_SERVER_MARKER_4c8a";

export interface Note {
  id: string;
  title: string;
  body: string;
}

const notes: Note[] = [
  { id: "n1", title: "Manifest routing", body: "A note on explicit defineApp() wiring." },
  { id: "n2", title: "Render modes", body: "A note on SPA, SSR, SSG, and ISG per route." },
  { id: "n3", title: "Capabilities", body: "This note is served by a typed capability." },
];

export function searchNotes(query: string, limit: number): Note[] {
  if (!Array.isArray(notes)) {
    throw new Error(NOTES_STORE_SERVER_MARKER);
  }
  const needle = query.toLowerCase();
  return notes
    .filter(
      (note) =>
        note.title.toLowerCase().includes(needle) || note.body.toLowerCase().includes(needle),
    )
    .slice(0, limit);
}

export function createNote(title: string, body: string): Note {
  const note: Note = { id: `n${notes.length + 1}-${Date.now().toString(36)}`, title, body };
  notes.push(note);
  return note;
}
