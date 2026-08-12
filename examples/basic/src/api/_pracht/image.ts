import type { ApiRouteArgs } from "@pracht/core";

declare const __PRACHT_IMAGE_BACKEND__: string;

// Serves /api/_pracht/image — the endpoint the default <Image> loader targets.
// Node uses the Sharp-backed optimizer. Edge targets retain the same public
// route and generated API type while redirecting validated same-origin paths;
// the compile-time branch keeps @pracht/image/node out of edge bundles.
let nodeImageHandler: ((args: ApiRouteArgs) => Response | Promise<Response>) | undefined;

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

async function handleImage(args: ApiRouteArgs): Promise<Response> {
  if (__PRACHT_IMAGE_BACKEND__ === "node") {
    if (!nodeImageHandler) {
      const { createImageHandler } = await import("@pracht/image/node");
      // Only same-origin (relative) sources are allowed; opt remote hosts in
      // via remotePatterns when the example is adapted for production.
      nodeImageHandler = createImageHandler({
        localOrigin: process.env.PRACHT_ORIGIN,
      });
    }
    return nodeImageHandler(args);
  }

  const requestUrl = new URL(args.request.url);
  const source = requestUrl.searchParams.get("url");
  if (
    !source ||
    !source.startsWith("/") ||
    source.startsWith("//") ||
    source.includes("\\") ||
    containsAsciiControl(source)
  ) {
    return new Response("Only same-origin image paths are supported on this edge deployment.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const target = new URL(source, requestUrl.origin);
  if (target.origin !== requestUrl.origin) {
    return new Response("Only same-origin image paths are supported on this edge deployment.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return Response.redirect(target, 307);
}

export const GET = handleImage;
export const HEAD = handleImage;
