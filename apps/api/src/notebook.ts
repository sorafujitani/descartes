import { DurableObject } from "cloudflare:workers";
import { github, type Env, type GitHubRepository } from "./github.ts";
import { fail, HttpError } from "./repository.ts";

/**
 * One object per notebook scope: tree/title/content caches outlive Worker isolates, and the
 * adapter's write queue serializes every Contents API write to the branch, not just one isolate's.
 * The cron warm runs here too, so it reuses and refreshes the same caches and prune schedule.
 */
export class Notebook extends DurableObject<Env> implements GitHubRepository {
  #store?: GitHubRepository;
  get #repository() {
    return (this.#store ??= github(this.env));
  }
  privateOnly() {
    return this.#repository.privateOnly();
  }
  list(cursor: number) {
    return this.#repository.list(cursor);
  }
  search(query: string, cursor?: number) {
    return this.#repository.search(query, cursor);
  }
  get(id: string) {
    return this.#repository.get(id);
  }
  save(id: string, markdown: string, sha?: string) {
    return this.#repository.save(id, markdown, sha);
  }
  asset(name: string) {
    return this.#repository.asset(name);
  }
  attach(name: string, bytes: Uint8Array) {
    return this.#repository.attach(name, bytes);
  }
  warm(blobBudget?: number) {
    return this.#repository.warm(blobBudget);
  }
}

/** The subset of DurableObjectNamespace used here; tests substitute a fake. */
export type NotebookId = { readonly __notebookId: unique symbol };
export interface NotebookNamespace {
  idFromName(name: string): NotebookId;
  get(id: NotebookId): GitHubRepository;
}
export type WorkerEnv = Env & { NOTEBOOK?: NotebookNamespace };

// Credentials are part of the scope so token rotation never reuses an old object,
// but only a digest reaches the object name.
async function scopeOf(env: Env) {
  const scope = JSON.stringify([env.GITHUB_REPOSITORY, env.GITHUB_BRANCH, env.GITHUB_TOKEN]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// RPC rebuilds thrown errors without their class; restore the status set by fail().
async function relay<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status <= 599)
      throw new HttpError(status, (error as Error).message);
    throw error;
  }
}

export async function notebookFor(env: WorkerEnv): Promise<GitHubRepository> {
  if (!env.NOTEBOOK) fail(503, "Document repository not configured.");
  const stub = env.NOTEBOOK.get(env.NOTEBOOK.idFromName(await scopeOf(env)));
  return {
    privateOnly: () => relay(() => stub.privateOnly()),
    list: (cursor) => relay(() => stub.list(cursor)),
    search: (query, cursor) => relay(() => stub.search(query, cursor)),
    get: (id) => relay(() => stub.get(id)),
    save: (id, markdown, sha) => relay(() => stub.save(id, markdown, sha)),
    asset: (name) => relay(() => stub.asset(name)),
    attach: (name, bytes) => relay(() => stub.attach(name, bytes)),
    warm: (blobBudget) => relay(() => stub.warm(blobBudget)),
  };
}
