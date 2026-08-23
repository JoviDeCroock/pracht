import type { ContentSnapshotFields, ContentSnapshotOptions } from "./types.ts";

// Snapshot field selection shared by the authoring collection, which decides
// what to embed, and the runtime entry, which reports what it received. It
// stays free of `node:*` imports so `@pracht/content/runtime` keeps working on
// workerd and other filesystem-free deployment targets.

export const ALL_SNAPSHOT_FIELDS: ContentSnapshotFields = Object.freeze({ body: true, raw: true });

// `raw` duplicates the exact source that compiled route modules and build-time
// artifact generators already carry, and nothing in the framework reads it
// from a runtime snapshot — so embedding it is opt-in. `body` stays embedded
// because the search and page capability helpers read it at request time.
export const DEFAULT_SNAPSHOT_FIELDS: ContentSnapshotFields = Object.freeze({
  body: true,
  raw: false,
});

const SNAPSHOT_FIELD_NAMES = ["body", "raw"] as const;

/** Interpret `defineCollection({ snapshot })`; unset fields take the defaults. */
export function normalizeSnapshotOptions(
  fields: ContentSnapshotOptions | undefined,
): ContentSnapshotFields {
  if (!fields) return DEFAULT_SNAPSHOT_FIELDS;
  return Object.freeze({ body: fields.body !== false, raw: fields.raw === true });
}

/**
 * Interpret a snapshot's `fields` marker. An absent marker means the snapshot
 * embeds every representation — the marker is only written when something was
 * dropped, so hand-written snapshots without one keep working.
 */
export function normalizeSnapshotFields(
  fields: ContentSnapshotOptions | undefined,
): ContentSnapshotFields {
  if (!fields) return ALL_SNAPSHOT_FIELDS;
  return Object.freeze({ body: fields.body !== false, raw: fields.raw !== false });
}

export function assertSnapshotOptions(fields: unknown): void {
  if (fields === undefined) return;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new TypeError("defineCollection() snapshot must be an object.");
  }
  for (const name of SNAPSHOT_FIELD_NAMES) {
    const value = (fields as Record<string, unknown>)[name];
    if (value !== undefined && typeof value !== "boolean") {
      throw new TypeError(`defineCollection() snapshot.${name} must be a boolean.`);
    }
  }
  for (const name of Object.keys(fields)) {
    if (!(SNAPSHOT_FIELD_NAMES as readonly string[]).includes(name)) {
      throw new TypeError(
        `defineCollection() snapshot does not support ${JSON.stringify(name)}; only "body" and "raw" can be omitted.`,
      );
    }
  }
}
