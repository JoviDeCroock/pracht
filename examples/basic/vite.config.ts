import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

async function resolveAdapter() {
  if (process.env.PRACHT_ADAPTER === "vercel") {
    const { vercelAdapter } = await import("@pracht/adapter-vercel");
    return vercelAdapter();
  }

  if (process.env.PRACHT_ADAPTER === "cloudflare") {
    const { cloudflareAdapter } = await import("@pracht/adapter-cloudflare");
    return cloudflareAdapter();
  }

  const { nodeAdapter } = await import("@pracht/adapter-node");
  return nodeAdapter();
}

export default defineConfig(async () => ({
  plugins: [pracht({ adapter: await resolveAdapter() })],
}));
