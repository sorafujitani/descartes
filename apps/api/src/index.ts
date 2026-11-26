import { authorize } from "./auth.ts";
import { HttpError, type Env } from "./github.ts";
import { notebookFor, type WorkerEnv } from "./notebook.ts";
import { fail } from "./repository.ts";
import { createApi } from "./routes.ts";
export { Notebook } from "./notebook.ts";

const configured = (env: Env) =>
  !!env.GITHUB_TOKEN && /^[-\w.]+\/[-\w.]+$/.test(env.GITHUB_REPOSITORY);
const app = createApi<WorkerEnv>(
  async (req, env) => {
    if (!(await authorize(req, env))) fail(401, "Access login required.");
    if (!configured(env)) fail(503, "Document repository not configured.");
    return notebookFor(env);
  },
  { report: (report) => console.info(JSON.stringify(report)) },
);

/**
 * Cron-driven index warming. A push webhook cannot reach the Worker because the whole hostname
 * sits behind Cloudflare Access, so external Git edits are picked up on a schedule instead.
 * It runs inside the notebook's Durable Object, sharing its adapter with HTTP requests.
 */
async function scheduled(_controller: unknown, env: WorkerEnv) {
  const started = performance.now();
  // Never log paths, titles, bodies, credentials or upstream exception messages.
  const log = (fields: Record<string, unknown>) =>
    console.info(
      JSON.stringify({
        event: "search_index_warm",
        ...fields,
        timings: { total: performance.now() - started },
      }),
    );
  if (!env.SEARCH_DB || !env.NOTEBOOK || !configured(env)) return log({ status: "skipped" });
  try {
    log({ status: "ok", ...(await (await notebookFor(env)).warm()) });
  } catch (error) {
    log({ status: "error", httpStatus: error instanceof HttpError ? error.status : 500 });
    throw error;
  }
}
export default { fetch: app.fetch, scheduled };
