// `@pracht/adapter-node/bridge`: the one `node:http` ↔ Web Request/Response
// bridge. The Node adapter's handler and Vite's dev server both answer through
// it, so a body limit, a disconnect signal, or a backpressure fix lands in both.
import type { ServerResponse } from "node:http";

import { writeWebResponse as writeResponse } from "./node-request.ts";

export {
  createWebRequest,
  DEFAULT_MAX_BODY_SIZE,
  type NodeBridgeOptions,
  writeNodeResponseHeaders,
} from "./node-request.ts";

/**
 * Write a Web `Response` to a `node:http` response: every `Set-Cookie` kept
 * apart, the body streamed with backpressure, and the body cancelled when the
 * client disconnects. Resolves once the response finished or the client left;
 * rejects only when the body stream itself fails.
 */
export function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  return writeResponse(res, response);
}
