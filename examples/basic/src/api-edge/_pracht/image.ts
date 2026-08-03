import type { BaseRouteArgs } from "@pracht/core";

function redirectToLocalImage({ request }: BaseRouteArgs) {
  const requestUrl = new URL(request.url);
  const source = requestUrl.searchParams.get("url");

  if (!source || !source.startsWith("/") || source.startsWith("//") || source.includes("\\")) {
    return new Response("Only same-origin image paths are supported on this edge deployment.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return Response.redirect(new URL(source, requestUrl.origin), 307);
}

export const GET = redirectToLocalImage;
export const HEAD = redirectToLocalImage;
