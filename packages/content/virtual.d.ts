declare module "virtual:pracht/content/*" {
  import type { ContentSnapshotCollection } from "@pracht/content";

  export const collection: ContentSnapshotCollection<Record<string, unknown>, unknown>;
  export default collection;
}
