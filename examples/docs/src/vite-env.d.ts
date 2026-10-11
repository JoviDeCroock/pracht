/// <reference types="@pracht/markdown/client" />

declare module "virtual:docs-mcp-index" {
  const data: import("./server/docs-index.ts").DocsIndexData;
  export default data;
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
