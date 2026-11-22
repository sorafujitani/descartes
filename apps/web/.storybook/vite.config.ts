import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Prebundle these before browser tests start; on-demand optimization otherwise reloads
// the Vitest iframe during its first cold run and can interrupt test collection.
export const storybookDependencies = [
  "@ox-content/wasm",
  "@codemirror/commands",
  "@codemirror/lang-markdown",
  "@codemirror/language",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/highlight",
];

// Intentionally standalone: no worker environment, cf credentials, API or network mocks.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: storybookDependencies },
});
