import { uuid, titleOf, searchTerms, type Document } from "@descartes/shared";
import { fail, HttpError, type Repository } from "./repository.ts";
import { SearchIndex, type SearchDatabase, type IndexEntry as Entry } from "./search-index.ts";
export { fail, HttpError } from "./repository.ts";
export interface Env {
  GITHUB_REPOSITORY: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
  SEARCH_DB?: SearchDatabase;
}
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
const decode = (str: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)));
const docPath = new RegExp("^docs/(" + uuid + ")\\.md$");
// Leave room for Access JWKS, repository privacy and tree reads within Workers Free's 50 subrequests.
const PAGE_SIZE = 32;
const CONCURRENCY = 6;
const TREE_TTL = 15_000;
const PRIVACY_TTL = 60_000;
const PRUNE_INTERVAL = 10 * 60_000;
const CONTENT_BUDGET = 8 * 1024 * 1024;
// Cron runs have no Access JWKS read: privacy + tree + blobs stay under Workers Free's 50 subrequests.
const WARM_BLOBS = 40;
// Commit each chunk so a run cut short by limits still keeps its progress for the next run.
const WARM_CHUNK = 8;
export type WarmReport = {
  documents: number;
  indexed: number;
  failed: number;
  oversized: number;
  remaining: number;
};
export type GitHubRepository = Repository & {
  /** Background index maintenance for the cron handler; deliberately not part of the HTTP API. */
  warm(blobBudget?: number): Promise<WarmReport>;
};

async function mapConcurrent<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length && failure === undefined) {
        const index = next++;
        try {
          results[index] = await fn(items[index]);
        } catch (error) {
          failure = error;
        }
      }
    }),
  );
  if (failure !== undefined) throw failure;
  return results;
}

/** One adapter per repository/credential/branch, retained by the Worker (never a public HTTP cache). */
export function github(env: Env, send: typeof fetch = fetch, now = Date.now): GitHubRepository {
  const root = "https://api.github.com/repos/" + env.GITHUB_REPOSITORY;
  const ref = encodeURIComponent(env.GITHUB_BRANCH || "main");
  // Only the docs subtree is listed, so screenshots in assets/ can never make the tree truncate.
  const docsTree = "/git/trees/" + encodeURIComponent((env.GITHUB_BRANCH || "main") + ":docs");
  const index = env.SEARCH_DB ? new SearchIndex(env.SEARCH_DB, env) : undefined;
  // Worst case: one GitHub read and one D1 write per large document, plus auth/metadata/query overhead.
  const pageSize = index ? 16 : PAGE_SIZE;
  let indexRetryAt = 0;
  let prunedAt = -Infinity;
  async function indexed<T>(operation: (index: SearchIndex) => Promise<T>): Promise<T | undefined> {
    if (!index || now() < indexRetryAt) return undefined;
    try {
      return await operation(index);
    } catch {
      indexRetryAt = now() + 30_000;
      console.warn(JSON.stringify({ event: "search_index_unavailable", retryMs: 30_000 }));
      return undefined;
    }
  }
  const titles = new Map<string, string>();
  const contents = new Map<string, string>();
  const loading = new Map<string, Promise<string>>();
  let activeBlobs = 0;
  const blobWaiters: (() => void)[] = [];
  async function withBlobSlot<T>(task: () => Promise<T>): Promise<T> {
    if (activeBlobs >= CONCURRENCY) await new Promise<void>((resolve) => blobWaiters.push(resolve));
    else activeBlobs++;
    try {
      return await task();
    } finally {
      const next = blobWaiters.shift();
      if (next) next();
      else activeBlobs--;
    }
  }
  let contentBytes = 0;
  let tree: { entries: Entry[]; etag?: string; expires: number } | undefined;
  let treeLoading: { generation: number; promise: Promise<Entry[]> } | undefined;
  let generation = 0;
  let checkingPrivate: Promise<void> | undefined;
  // Only a confirmed private=true result is reused, and only by reads.
  let privateUntil = -Infinity;
  let writes: Promise<unknown> = Promise.resolve();
  async function call(path: string, init?: RequestInit, raw = false) {
    const res = await send(root + path, {
      ...init,
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers: {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "User-Agent": "descartes",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (res.status === 409 || (res.status === 422 && init?.method === "PUT"))
      fail(409, "保存が競合しました。下書きをコピーして最新版を開いてください。");
    if (res.status === 404) fail(404, "文書またはリポジトリが見つかりません。");
    if (!res.ok && res.status !== 304) fail(502, "GitHub request failed (" + res.status + ").");
    return res;
  }
  function rememberTitle(sha: string, title: string) {
    titles.delete(sha);
    titles.set(sha, title);
    if (titles.size > 4096) titles.delete(titles.keys().next().value!);
  }
  function remember(sha: string, markdown: string) {
    rememberTitle(sha, titleOf(markdown).slice(0, 512));
    const bytes = markdown.length * 2;
    if (bytes > CONTENT_BUDGET || contents.has(sha)) return;
    while (contentBytes + bytes > CONTENT_BUDGET || contents.size >= 1024) {
      const oldest = contents.keys().next().value!;
      contentBytes -= contents.get(oldest)!.length * 2;
      contents.delete(oldest);
    }
    contents.set(sha, markdown);
    contentBytes += bytes;
  }
  async function blob(sha: string) {
    const cached = contents.get(sha);
    if (cached !== undefined) {
      if (!titles.has(sha)) remember(sha, cached);
      contents.delete(sha);
      contents.set(sha, cached);
      return cached;
    }
    if (loading.has(sha)) return loading.get(sha)!;
    const promise = (async () => {
      const data = await withBlobSlot(async () => (await call("/git/blobs/" + sha)).json());
      if (data.encoding && data.encoding !== "base64") fail(502, "Invalid GitHub blob encoding.");
      const markdown = decode(data.content);
      remember(sha, markdown);
      return markdown;
    })();
    loading.set(sha, promise);
    try {
      return await promise;
    } finally {
      loading.delete(sha);
    }
  }
  async function hydrate(page: Entry[]) {
    const known = await indexed((database) => database.titles(page.map((entry) => entry.sha)));
    if (!known) return false;
    for (const [sha, title] of known) rememberTitle(sha, title);
    const missing = [
      ...new Set(page.filter((entry) => !known.has(entry.sha)).map((entry) => entry.sha)),
    ];
    // GitHub reads stay outside indexed() so a transient GitHub error is not mistaken for a D1
    // outage, which would now disable search for the whole backoff window.
    const blobs = await mapConcurrent(missing, async (sha) => ({
      sha,
      markdown: await blob(sha),
    }));
    return (
      (await indexed(async (database) => {
        await database.put(blobs);
        return true;
      })) ?? false
    );
  }
  async function snapshot(): Promise<Entry[]> {
    if (tree && tree.expires > now()) return tree.entries;
    if (treeLoading?.generation === generation) return treeLoading.promise;
    const version = generation;
    const previous = tree;
    const promise = (async () => {
      let response: Response | undefined;
      try {
        response = await call(docsTree, {
          headers: previous?.etag ? { "If-None-Match": previous.etag } : {},
        });
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
        // A missing branch and a branch without docs/ both 404; only the latter is an empty notebook.
        await call("/git/trees/" + ref);
      }
      let entries: Entry[];
      if (response?.status === 304 && previous) entries = previous.entries;
      else {
        const data = response ? await response.json() : { tree: [] };
        if (data.truncated) fail(503, "Repository tree is too large.");
        entries = [];
        for (const f of data.tree as { path: string; sha: string; type: string }[]) {
          const id = f.type === "blob" && docPath.exec("docs/" + f.path)?.[1];
          if (id) entries.push({ id, sha: f.sha });
        }
        entries.sort((a, b) => a.id.localeCompare(b.id));
        if (version === generation && now() - prunedAt >= PRUNE_INTERVAL) {
          prunedAt = now();
          // A save racing this tree read may lose its fresh row; that only costs one re-fetch.
          await indexed((database) => database.prune(entries));
        }
      }
      if (version === generation) {
        tree = {
          entries,
          etag:
            response?.headers.get("ETag") ??
            (response?.status === 304 ? previous?.etag : undefined),
          expires: now() + TREE_TTL,
        };
      }
      return entries;
    })();
    treeLoading = { generation: version, promise };
    try {
      return await promise;
    } finally {
      if (treeLoading?.promise === promise) treeLoading = undefined;
    }
  }
  function invalidate() {
    generation++;
    tree = undefined;
  }
  function write(path: string, bytes: Uint8Array, sha?: string): Promise<string> {
    // Contents API writes to the same branch must be serialized, even for different files.
    const result = writes.then(async () => {
      try {
        const r = await call("/contents/" + path, {
          method: "PUT",
          body: JSON.stringify({
            message: "Save " + path,
            branch: env.GITHUB_BRANCH || "main",
            content: base64(bytes),
            sha,
          }),
        });
        return (await r.json()).content.sha as string;
      } finally {
        invalidate();
      }
    });
    writes = result.catch(() => {});
    return result;
  }
  async function privateOnly({ fresh = false } = {}) {
    // A short success-only window removes a GitHub round trip from most reads; writes never use it.
    if (!fresh && now() < privateUntil) return;
    if (!checkingPrivate)
      checkingPrivate = (async () => {
        try {
          if ((await (await call("")).json()).private !== true)
            fail(403, "A private document repository is required.");
          privateUntil = now() + PRIVACY_TTL;
        } catch (error) {
          privateUntil = -Infinity;
          throw error;
        }
      })();
    try {
      await checkingPrivate;
    } finally {
      checkingPrivate = undefined;
    }
  }
  return {
    privateOnly,
    async warm(blobBudget = WARM_BLOBS) {
      const report: WarmReport = {
        documents: 0,
        indexed: 0,
        failed: 0,
        oversized: 0,
        remaining: 0,
      };
      if (!index) return report;
      await privateOnly();
      const prunedBefore = prunedAt;
      const entries = await snapshot();
      report.documents = entries.length;
      // The tree read may already have pruned; otherwise prune here so every run bounds the table.
      if (prunedAt === prunedBefore) {
        prunedAt = now();
        await indexed((database) => database.prune(entries));
      }
      const known = await indexed((database) => database.titles(entries.map((e) => e.sha)));
      if (!known) return { ...report, remaining: entries.length };
      for (const [sha, title] of known) rememberTitle(sha, title);
      const missing = [...new Set(entries.map((e) => e.sha).filter((sha) => !known.has(sha)))];
      const batch = missing.slice(0, Math.max(0, blobBudget));
      report.remaining = missing.length - batch.length;
      for (let i = 0; i < batch.length; i += WARM_CHUNK) {
        const loaded = await mapConcurrent(batch.slice(i, i + WARM_CHUNK), async (sha) => {
          try {
            return { sha, markdown: await blob(sha) };
          } catch {
            return undefined;
          }
        });
        const blobs = loaded.filter((item) => item !== undefined);
        const oversized = await indexed((database) => database.put(blobs));
        if (oversized === undefined) {
          report.remaining += batch.length - i;
          break;
        }
        report.indexed += blobs.length - oversized;
        report.oversized += oversized;
        report.failed += loaded.length - blobs.length;
      }
      return report;
    },
    async list(cursor) {
      const docs = await snapshot();
      const known = new Map<string, string>();
      for (const entry of docs.slice(cursor)) {
        const title = titles.get(entry.sha);
        if (title !== undefined) known.set(entry.sha, title);
      }
      const unknown = docs.slice(cursor).filter((entry) => !known.has(entry.sha));
      const stored = await indexed((database) => database.titles(unknown.map((e) => e.sha)));
      for (const [sha, title] of stored ?? []) {
        rememberTitle(sha, title);
        known.set(sha, title);
      }
      // Known titles cost no GitHub request, so a page ends only at the blob-read budget.
      const missing = new Set<string>();
      let end = cursor;
      for (; end < docs.length; end++) {
        const sha = docs[end].sha;
        if (known.has(sha) || missing.has(sha)) continue;
        if (missing.size === pageSize) break;
        missing.add(sha);
      }
      const loaded = await mapConcurrent([...missing], async (sha) => ({
        sha,
        markdown: await blob(sha),
      }));
      for (const { sha, markdown } of loaded) known.set(sha, titleOf(markdown).slice(0, 512));
      await indexed((database) => database.put(loaded));
      const items = docs
        .slice(cursor, end)
        .map((f) => ({ id: f.id, title: known.get(f.sha) || f.id }));
      return { items, next: end < docs.length ? end : null };
    },
    async search(query, cursor = 0) {
      const terms = searchTerms(query);
      if (!terms.length) return { items: [], next: null };
      // Full-text search requires D1; scanning blobs instead is too slow and too expensive in
      // subrequests to be a useful fallback, so an outage is reported rather than hidden.
      const unavailable: () => never = () => fail(503, "検索インデックスを利用できません。");
      if (!index || now() < indexRetryAt) unavailable();
      const entries = await snapshot();
      const ready = await indexed((database) => database.searchComplete(entries, query));
      if (ready) return { items: ready, next: null };
      if (ready === undefined) unavailable();
      // A cold index is hydrated one page per request to stay within the subrequest budget.
      const page = entries.slice(cursor, cursor + pageSize);
      if (!(await hydrate(page))) unavailable();
      const last = cursor + page.length >= entries.length;
      if (last) {
        const complete = await indexed((database) => database.searchComplete(entries, query));
        if (complete) return { items: complete, next: null };
      }
      const items = await indexed((database) => database.search(page, query));
      if (!items) unavailable();
      return { items, next: last ? null : cursor + page.length };
    },
    async get(id): Promise<Document> {
      // The tree SHA may be up to TREE_TTL old; saves stay safe because GitHub rejects stale SHAs.
      const entry = (await snapshot()).find((e) => e.id === id);
      if (entry) {
        const { sha } = entry;
        let markdown = contents.has(sha)
          ? await blob(sha)
          : await indexed((database) => database.markdown(sha));
        if (markdown !== undefined) remember(sha, markdown);
        else {
          const loaded = await blob(sha);
          await indexed((database) => database.put([{ sha, markdown: loaded }]));
          markdown = loaded;
        }
        return { id, markdown, title: titleOf(markdown) || id, sha };
      }
      // Not in the snapshot yet (e.g. created by another isolate within the TTL): ask GitHub directly.
      const data = await (await call("/contents/docs/" + id + ".md?ref=" + ref)).json();
      if (data.encoding !== "base64") fail(413, "Document is too large.");
      const markdown = decode(data.content);
      remember(data.sha, markdown);
      await indexed((database) => database.put([{ sha: data.sha, markdown }]));
      return { id, markdown, title: titleOf(markdown) || id, sha: data.sha };
    },
    async save(id, markdown, sha): Promise<Document> {
      const version = await write("docs/" + id + ".md", new TextEncoder().encode(markdown), sha);
      remember(version, markdown);
      // A derived-index failure must never turn a successful Git commit into a failed save.
      await indexed((database) => database.put([{ sha: version, markdown }]));
      return { id, markdown, title: titleOf(markdown), sha: version };
    },
    async asset(name) {
      return call("/contents/assets/" + name + "?ref=" + ref, undefined, true);
    },
    async attach(name, bytes) {
      await write("assets/" + name, bytes);
      return { path: "../assets/" + name };
    },
  };
}
