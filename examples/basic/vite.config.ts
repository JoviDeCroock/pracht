import { defineConfig } from "vite";
import { previte } from "@previte/vite-plugin";

async function resolveAdapter() {
  if (process.env.PREVITE_ADAPTER === "vercel") {
    const { vercelAdapter } = await import("@previte/adapter-vercel");
    return vercelAdapter();
  }

  if (process.env.PREVITE_ADAPTER === "node") {
    const { nodeAdapter } = await import("@previte/adapter-node");
    return nodeAdapter();
  }

  const { cloudflareAdapter } = await import("@previte/adapter-cloudflare");
  return cloudflareAdapter();
}

export default defineConfig(async () => ({
  plugins: [previte({ adapter: await resolveAdapter() })],
}));
