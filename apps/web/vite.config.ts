import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  plugins: [react(), cloudflare()],
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            // Libraries change far less often than the app, so they get their own hashed chunks
            // and stay cached across app-only deploys.
            codeSplitting: {
              groups: [
                { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
                {
                  name: "codemirror",
                  test: /node_modules[\\/](@codemirror|@lezer|style-mod|w3c-keyname|crelt|@marijn)[\\/]/,
                },
              ],
            },
          },
        },
      },
    },
  },
});
