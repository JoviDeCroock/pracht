import { redirect, stripBase, type MiddlewareFn } from "@pracht/core";

// Root-level pages middleware: registered as the named middleware "pages" and
// applied to every page route. API routes under src/api are not wrapped.
export const middleware: MiddlewareFn = async ({ request, url }, next) => {
  if (stripBase(url.pathname) === "/legacy") {
    return redirect("/about", { request });
  }

  const response = await next();
  response.headers.set("x-pages-middleware", "ran");
  return response;
};
