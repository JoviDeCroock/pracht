/// <reference types="@pracht/markdown/client" />

declare module "virtual:pracht/content/docs" {
  import type { ContentSnapshotCollection } from "@pracht/content";
  import type { CompiledMarkdown } from "@pracht/markdown";

  const docs: ContentSnapshotCollection<{ title?: string; lead?: string }, CompiledMarkdown>;
  export default docs;
}

declare module "*.css" {
  const mod: any;
  export default mod;
}

declare module "*.mdx" {
  const mod: Record<string, unknown>;
  export default mod;
  export const Component: import("preact").FunctionComponent;
}
