import { defineConfig } from "vite";
import { viact } from "@viact/vite-plugin";
import { markdown } from "./vite-plugin-md";

export default defineConfig({
  plugins: [markdown(), viact({ adapter: "cloudflare" })],
});
