/// <reference types="@pracht/markdown/client" />

declare module "*.css" {
  const mod: any;
  export default mod;
}

declare module "*.mdx" {
  const mod: Record<string, unknown>;
  export default mod;
  export const Component: import("preact").FunctionComponent;
}
