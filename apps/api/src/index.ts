import { authorize } from "./auth.ts";
import { github, HttpError, type Env, type GitHubRepository } from "./github.ts";
import { fail } from "./repository.ts";
import { createApi } from "./routes.ts";

const repositories = new Map<string, GitHubRepository>();
function repositoryFor(env: Env) {
  if (!env.GITHUB_TOKEN || !/^[-\w.]+\/[-\w.]+$/.test(env.GITHUB_REPOSITORY)) return undefined;
  // Credentials are part of the scope: token rotation never reuses an old adapter.
  const key = JSON.stringify([env.GITHUB_REPOSITORY, env.GITHUB_BRANCH, env.GITHUB_TOKEN]);
  let store = repositories.get(key);
  if (!store) {
    if (repositories.size >= 4) repositories.delete(repositories.keys().next().value!);
    store = github(env);
    repositories.set(key, store);
  }
  return store;
}
const app = createApi<Env>(
  async (req, env) => {
    if (!(await authorize(req, env))) fail(401, "Access login required.");
    return repositoryFor(env) ?? fail(503, "Document repository not configured.");
  },
  { report: (report) => console.info(JSON.stringify(report)) },
);

/**
 * Cron-driven index warming. A push webhook cannot reach the Worker because the whole hostname
 * sits behind Cloudflare Access, so external Git edits are picked up on a schedule instead.
 */
async function scheduled(_controller: unknown, env: Env) {
  const started = performance.now();
  const store = env.SEARCH_DB ? repositoryFor(env) : undefined;
  // Never log paths, titles, bodies, credentials or upstream exception messages.
  const log = (fields: Record<string, unknown>) =>
    console.info(
      JSON.stringify({
        event: "search_index_warm",
        ...fields,
        timings: { total: performance.now() - started },
      }),
    );
  if (!store) return log({ status: "skipped" });
  try {
    log({ status: "ok", ...(await store.warm()) });
  } catch (error) {
    log({ status: "error", httpStatus: error instanceof HttpError ? error.status : 500 });
    throw error;
  }
}
export default { fetch: app.fetch, scheduled };
