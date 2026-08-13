import type { MiddlewareFn } from "@pracht/core";
import { markdownResponse, prefersMarkdown } from "@pracht/core/server";

/** Demonstrates middleware-owned Markdown for one dynamic route module. */
export const middleware: MiddlewareFn = ({ params, request }, next) => {
  if (!prefersMarkdown(request.headers.get("accept"))) return next();

  return markdownResponse(`# Product ${params.productId}\n`);
};
