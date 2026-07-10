import { createImageHandler } from "@pracht/image/node";

// Serves /api/_pracht/image — the endpoint the default <Image> loader targets.
// Only same-origin (relative) sources are allowed; opt remote hosts in via
// remotePatterns, e.g. [{ protocol: "https", hostname: "images.example.com" }].
const imageHandler = createImageHandler();

export const GET = imageHandler;
export const HEAD = imageHandler;
