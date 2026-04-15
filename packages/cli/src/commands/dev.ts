import { defineCommand } from "citty";
import { createServer } from "vite";

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

    const server = await createServer({
      root: process.cwd(),
      server: { port },
    });

    await server.listen();
    server.printUrls();
  },
});
