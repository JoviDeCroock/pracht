import type { MiddlewareFn } from "@pracht/core";

export interface VisitorContext {
  visitor?: string;
}

/**
 * Reads the `visitor` cookie into `context.visitor`. Runs for the region
 * routes' documents and — through the region endpoint — for every region
 * those pages embed, so a cached page's region still sees the visitor.
 */
export const middleware: MiddlewareFn<VisitorContext> = ({ request, context }, next) => {
  const match = /(?:^|;\s*)visitor=([^;]+)/.exec(request.headers.get("cookie") ?? "");
  if (match) context.visitor = decodeURIComponent(match[1]);
  return next();
};
