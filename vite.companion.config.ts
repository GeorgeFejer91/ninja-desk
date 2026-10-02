import { defineConfig } from "vite";

export default defineConfig({
  root: "companion",
  base: "./",
  build: { outDir: "../companion-dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
