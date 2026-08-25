import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@worker": path.resolve(__dirname, "worker"),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
