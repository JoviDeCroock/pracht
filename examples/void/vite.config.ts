import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { voidAdapter } from "@pracht/adapter-void";

export default defineConfig({
  plugins: [pracht({ adapter: voidAdapter() })],
});
