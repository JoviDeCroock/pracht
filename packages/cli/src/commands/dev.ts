import { defineCommand } from "citty";
import { createServer } from "vite";

import { collectAppGraph } from "../app-graph.js";
import { formatDevBanner, supportsColor } from "../dev-banner.js";

export default defineCommand({
  meta: {
    name: "dev",
    description: "Start development server with HMR",
  },
  args: {
    port: {
      type: "positional",
      description: "Port number",
      required: false,
    },
  },
  async run({ args }) {
    const port = parseInt(process.env.PORT || args.port || "3000", 10);
    const root = process.cwd();

    const server = await createServer({
      root,
      server: { port },
    });

    await server.listen();

    try {
      const graph = await collectAppGraph(server, root);
      const urls = server.resolvedUrls ?? { local: [], network: [] };
      console.log(
        formatDevBanner({
          apiRoutes: graph.api,
          color: supportsColor(),
          localUrls: urls.local,
          networkUrls: urls.network,
          routes: graph.routes,
        }),
      );
    } catch {
      // Not a resolvable pracht app graph (or it failed to load) — fall back
      // to Vite's own URL output so the dev server still starts cleanly.
      server.printUrls();
    }
  },
});
