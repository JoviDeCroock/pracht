declare module "virtual:pracht/content/*" {
  import type { ContentCollection } from "@pracht/content";

  export const collection: ContentCollection<Record<string, unknown>, unknown>;
  export default collection;
}
