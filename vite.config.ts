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
  test: { include: ["tests/**/*.test.ts", "apps/web/src/**/*.test.ts"] },
});
