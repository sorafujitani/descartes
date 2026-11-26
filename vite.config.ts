import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
const ignorePatterns = [
  "**/dist/**",
  "**/.cloudflare/**",
  "**/.build/**",
  "**/storybook-static/**",
];
export default defineConfig({
  fmt: { ignorePatterns: [...ignorePatterns, "pnpm-lock.yaml"] },
  lint: { ignorePatterns },
  // Worker modules import the workerd-only DurableObject base class.
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("tests/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: { include: ["tests/**/*.test.ts", "apps/web/src/**/*.test.ts"] },
});
