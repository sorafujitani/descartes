import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The editor page embedded in the Mac app (editor.html → dist-editor/). Standalone: no Cloudflare
 * worker, API or service worker. Relative URLs, because the Mac app serves it from its own
 * descartes-editor:// scheme.
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  publicDir: false,
  build: {
    outDir: "dist-editor",
    emptyOutDir: true,
    rollupOptions: { input: "editor.html" },
  },
});
