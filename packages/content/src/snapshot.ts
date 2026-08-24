import type { ContentSnapshotFields, ContentSnapshotOptions } from "./types.ts";

// Snapshot field selection shared by the authoring collection, which decides
// what to embed, and the runtime entry, which reports what it received. It
// stays free of `node:*` imports so `@pracht/content/runtime` keeps working on
// workerd and other filesystem-free deployment targets.

export const ALL_SNAPSHOT_FIELDS: ContentSnapshotFields = Object.freeze({ body: true, raw: true });

const SNAPSHOT_FIELD_NAMES = ["body", "raw"] as const;

/**
 * Interpret `defineCollection({ snapshot })` or a snapshot's `fields` marker.
 * Unset fields stay embedded, and an absent marker means every representation
 * is present so hand-written snapshots without one keep working.
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
