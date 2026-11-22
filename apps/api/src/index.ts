import { authorize } from "./auth.ts";
import { github, type Env } from "./github.ts";
import { fail, type Repository } from "./repository.ts";
import { createApi } from "./routes.ts";

const repositories = new Map<string, Repository>();
const app = createApi<Env>(
  async (req, env) => {
    if (!(await authorize(req, env))) fail(401, "Access login required.");
    if (!env.GITHUB_TOKEN || !/^[-\w.]+\/[-\w.]+$/.test(env.GITHUB_REPOSITORY))
      fail(503, "Document repository not configured.");
    // Credentials are part of the scope: token rotation never reuses an old adapter.
    const key = JSON.stringify([env.GITHUB_REPOSITORY, env.GITHUB_BRANCH, env.GITHUB_TOKEN]);
    let store = repositories.get(key);
    if (!store) {
      if (repositories.size >= 4) repositories.delete(repositories.keys().next().value!);
      store = github(env);
      repositories.set(key, store);
    }
    return store;
  },
  { report: (report) => console.info(JSON.stringify(report)) },
);
export default { fetch: app.fetch };
