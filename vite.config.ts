import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  build: { assetsInlineLimit: 0, rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), controller: resolve(import.meta.dirname, "controller.html") } } },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
