import type { MiddlewareFn } from "@pracht/core";

export interface VisitorContext {
  visitor?: string;
}

/**
 * Reads the `visitor` cookie into `context.visitor`. Runs for the server
 * island routes' documents and — through the server island endpoint — for
 * every server island those pages render, so a cached page's server island
 * still sees the visitor.
 */
export const middleware: MiddlewareFn<VisitorContext> = ({ request, context }, next) => {
  const match = /(?:^|;\s*)visitor=([^;]+)/.exec(request.headers.get("cookie") ?? "");
  if (match) context.visitor = decodeURIComponent(match[1]);
  return next();
};
