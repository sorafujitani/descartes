import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "../api/src/index.ts" with { type: "cf-worker" };
import * as demo from "../api/dev/demo.ts" with { type: "cf-worker" };
export default defineConfig(({ mode }) => ({
  worker: {
    name: "descartes",
    compatibilityDate: "2026-05-01",
    entrypoint: mode === "demo" ? demo : entrypoint,
    previewUrls: false,
    observability: {
      enabled: true,
      headSamplingRate: 1,
      redactQueryString: true,
      logs: { invocationLogs: false },
    },
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
    env:
      mode === "demo"
        ? {}
        : {
            GITHUB_REPOSITORY: bindings.secret(),
            GITHUB_BRANCH: bindings.text("main"),
            GITHUB_TOKEN: bindings.secret(),
            ACCESS_ISSUER: bindings.secret(),
            ACCESS_AUD: bindings.secret(),
            SEARCH_DB: bindings.d1({ name: "descartes-search" }),
          },
  },
}));
