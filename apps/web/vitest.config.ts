import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { storybookDependencies } from "./.storybook/vite.config";

// Keep the conventional filename: Storybook's Run tests UI discovers vitest.config.ts,
// not arbitrary --config filenames. CLI and interactive testing must use the same setup.
export default defineConfig({
  optimizeDeps: { include: storybookDependencies },
  // Do not merge the application Vite/Cloudflare configuration.
  plugins: [
    storybookTest({
      configDir: fileURLToPath(new URL("./.storybook", import.meta.url)),
      storybookScript: "pnpm storybook --no-open",
    }),
  ],
  test: {
    name: "storybook",
    testTimeout: 20_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        // Use full Chromium's new headless mode, not a DOM emulator.
        launchOptions: { channel: "chromium" },
      }),
      instances: [
        { browser: "chromium", name: "chromium-mobile", viewport: { width: 390, height: 844 } },
        { browser: "chromium", name: "chromium-desktop", viewport: { width: 1280, height: 900 } },
      ],
    },
  },
});
