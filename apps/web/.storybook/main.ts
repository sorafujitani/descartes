import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../src/*.stories.tsx"],
  framework: {
    name: "@storybook/react-vite",
    options: {
      // Never inherit apps/web/vite.config.ts: Cloudflare is for the deployed app only.
      builder: { viteConfigPath: fileURLToPath(new URL("./vite.config.ts", import.meta.url)) },
    },
  },
  addons: ["@storybook/addon-vitest"],
  core: { disableTelemetry: true },
  typescript: { reactDocgen: false },
};
export default config;
