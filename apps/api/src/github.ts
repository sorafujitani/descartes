import { uuid, titleOf, searchTerms, type Document } from "@descartes/shared";
import { fail, HttpError, type Repository } from "./repository.ts";
import {
  INDEX_BATCH_BYTES,
  indexRow,
  SearchIndex,
  type SearchDatabase,
  type IndexBlob,
  type IndexEntry,
  type IndexRow,
} from "./search-index.ts";
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
/*
 * Workers Free allows 50 subrequests per request; D1 calls are counted conservatively as well.
 * Fixed cost per request: Access JWKS 1 + privacy 1 + tree 1 + D1 prune 1 + at most 3 other
 * D1 queries (titles, completeness check, search) = 7. Blob reads (GraphQL batches, REST
 * blobs) and D1 index write batches of one page share PAGE_BUDGET = 40: 7 + 40 = 47 <= 50.
 * One GraphQL request carries up to GRAPHQL_BATCH small blobs, so a cold page of a few hundred
 * notes costs a handful of subrequests instead of one per note.
 */
const PAGE_BUDGET = 40;
// Planning keeps this much budget for unforeseen REST fallbacks, so a page always progresses.
const FALLBACK_RESERVE = 4;
const GRAPHQL_BATCH = 100;
const GRAPHQL_BYTES = 1024 * 1024;
// Larger blobs skip GraphQL: they would dominate a batch response and may come back truncated.
const GRAPHQL_BLOB_BYTES = 256 * 1024;
// Bounds memory and CPU of one page independently of the subrequest budget.
const PAGE_DOCS = 500;
const PAGE_BYTES = 2 * 1024 * 1024;
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
type Entry = IndexEntry & { size?: number };
type Budget = { left: number };
type Loaded = IndexBlob | IndexRow;
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
  const [owner, name] = env.GITHUB_REPOSITORY.split("/");
  const ref = encodeURIComponent(env.GITHUB_BRANCH || "main");
  // Only the docs subtree is listed, so screenshots in assets/ can never make the tree truncate.
  const docsTree = "/git/trees/" + encodeURIComponent((env.GITHUB_BRANCH || "main") + ":docs");
  const index = env.SEARCH_DB ? new SearchIndex(env.SEARCH_DB, env) : undefined;
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
  // `undefined`: GraphQL returned no usable text, so the REST blob endpoint must be used.
  const loading = new Map<string, Promise<string | undefined>>();
  const restLoading = new Map<string, Promise<string>>();
  // Immutable SHAs that GraphQL cannot serve (binary, truncated or undecidable) go straight to REST.
  const restOnly = new Set<string>();
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
  async function request(url: string, init?: RequestInit, raw = false) {
    const res = await send(url, {
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
  const call = (path: string, init?: RequestInit, raw = false) => request(root + path, init, raw);
  async function graphqlBlobs(shas: string[]) {
    const query = `query($owner: String!, $name: String!, ${shas
      .map((_, i) => `$b${i}: GitObjectID!`)
      .join(", ")}) { repository(owner: $owner, name: $name) { ${shas
      .map((_, i) => `b${i}: object(oid: $b${i}) { ... on Blob { text isBinary isTruncated } }`)
      .join(" ")} } }`;
    const variables: Record<string, string> = { owner, name };
    shas.forEach((sha, i) => (variables["b" + i] = sha));
    const res = await request("https://api.github.com/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      fail(502, "GitHub request failed.");
    }
    // Rate limits and permission problems arrive as 200 with `errors`; their text is never forwarded.
    const repository = data?.errors?.length ? undefined : data?.data?.repository;
    if (!repository) fail(502, "GitHub request failed.");
    return shas.map((_, i) => {
      const blob = repository["b" + i];
      if (blob?.isBinary !== false || blob.isTruncated !== false || typeof blob.text !== "string")
        return undefined;
      // The REST path decodes with TextDecoder, which drops a UTF-8 BOM; keep both paths identical.
      return (blob.text as string).replace(/^\uFEFF/, "");
    });
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
  function cached(sha: string) {
    const markdown = contents.get(sha);
    if (markdown === undefined) return undefined;
    if (!titles.has(sha)) remember(sha, markdown);
    contents.delete(sha);
    contents.set(sha, markdown);
    return markdown;
  }
  function settle<T>(map: Map<string, Promise<T>>, sha: string, promise: Promise<T>) {
    map.set(sha, promise);
    const done = () => {
      if (map.get(sha) === promise) map.delete(sha);
    };
    promise.then(done, done);
    return promise;
  }
  function restBlob(sha: string) {
    const running = restLoading.get(sha);
    if (running) return running;
    return settle(
      restLoading,
      sha,
      (async () => {
        const data = await withBlobSlot(async () => (await call("/git/blobs/" + sha)).json());
        if (data.encoding && data.encoding !== "base64") fail(502, "Invalid GitHub blob encoding.");
        const markdown = decode(data.content);
        remember(sha, markdown);
        return markdown;
      })(),
    );
  }
  /**
   * Reads the bodies of the entries from `start` on that `needs` selects, and ends the page where
   * the subrequest budget, PAGE_DOCS or PAGE_BYTES would be exceeded. Bodies are returned once per
   * SHA in tree order; with `d1` they are index rows whose write batches were paid from `budget`.
   */
  async function readPage(
    entries: Entry[],
    start: number,
    needs: (sha: string) => boolean,
    d1: boolean,
    budget: Budget,
  ): Promise<{ end: number; bodies: Loaded[] }> {
    const planned: { index: number; sha: string; body?: Promise<string | undefined> }[] = [];
    const seen = new Set<string>();
    const batches: string[][] = [];
    let batchBytes = 0,
      spent = 0,
      pageBytes = 0,
      rows = 0,
      rowBytes = 0,
      end = start;
    for (; end < entries.length; end++) {
      const { sha, size = 0 } = entries[end];
      if (seen.has(sha) || !needs(sha)) continue;
      if (planned.length === PAGE_DOCS || (planned.length && pageBytes + size > PAGE_BYTES)) break;
      const markdown = contents.get(sha);
      const running =
        markdown === undefined ? (loading.get(sha) ?? restLoading.get(sha)) : undefined;
      const rest =
        !running && markdown === undefined && (restOnly.has(sha) || size > GRAPHQL_BLOB_BYTES);
      const batch =
        !running &&
        markdown === undefined &&
        !rest &&
        (!batches.length ||
          batches.at(-1)!.length === GRAPHQL_BATCH ||
          batchBytes + size > GRAPHQL_BYTES);
      // Before reading, a row is estimated from the blob size: body + normalized text + title.
      const estimate = 2 * size + 512 * 4 + 256;
      const row = d1 && (!rows || rowBytes + estimate > INDEX_BATCH_BYTES);
      const cost = spent + Number(rest) + Number(batch) + rows + Number(row);
      if (cost + FALLBACK_RESERVE > budget.left) break;
      seen.add(sha);
      pageBytes += size;
      spent += Number(rest) + Number(batch);
      if (d1) {
        rows += Number(row);
        rowBytes = row ? estimate : rowBytes + estimate;
      }
      const item: (typeof planned)[number] = { index: end, sha };
      if (markdown !== undefined) item.body = Promise.resolve(cached(sha));
      else if (running) item.body = running;
      else if (rest) item.body = restBlob(sha);
      else {
        if (batch) {
          batches.push([]);
          batchBytes = 0;
        }
        batches.at(-1)!.push(sha);
        batchBytes += size;
      }
      planned.push(item);
    }
    if (!planned.length) return { end, bodies: [] };
    for (const shas of batches) {
      const read = withBlobSlot(() => graphqlBlobs(shas));
      shas.forEach((sha, i) =>
        settle(
          loading,
          sha,
          read.then((texts) => {
            const text = texts[i];
            if (text === undefined) {
              restOnly.add(sha);
              if (restOnly.size > 4096) restOnly.delete(restOnly.values().next().value!);
            } else remember(sha, text);
            return text;
          }),
        ),
      );
    }
    for (const item of planned) item.body ??= loading.get(item.sha);
    budget.left -= spent;
    const texts = await Promise.all(planned.map((item) => item.body));
    // Now that bodies and fallbacks are known, accept the longest prefix whose exact cost fits.
    const accepted: Loaded[] = [];
    const fallbacks: number[] = [];
    let cost = 0;
    rows = 0;
    rowBytes = 0;
    for (const [k, item] of planned.entries()) {
      const text = texts[k];
      let body: Loaded = { sha: item.sha, markdown: text ?? "" };
      let next = cost + Number(text === undefined);
      if (d1) {
        // Fallback bodies are unknown yet; a row of at most INDEX_BATCH_BYTES needs one batch.
        let size = INDEX_BATCH_BYTES;
        if (text !== undefined) {
          const row = indexRow(body);
          body = row;
          size = row.size;
        }
        const row = !rows || rowBytes + size > INDEX_BATCH_BYTES;
        next += Number(row);
        rowBytes = row ? size : rowBytes + size;
        rows += Number(row);
      }
      if (next > budget.left) {
        end = item.index;
        break;
      }
      cost = next;
      if (text === undefined) fallbacks.push(accepted.length);
      accepted.push(body);
    }
    // Only reachable when an earlier read in the same request already spent the budget.
    if (end === start) fail(503, "Search is temporarily unavailable.");
    budget.left -= cost;
    await Promise.all(
      fallbacks.map(async (k) => {
        const markdown = await restBlob(accepted[k].sha);
        accepted[k] = d1
          ? indexRow({ sha: accepted[k].sha, markdown })
          : { ...accepted[k], markdown };
      }),
    );
    return { end, bodies: accepted };
  }
  const indexUsable = () => index !== undefined && now() >= indexRetryAt;
  /** Indexes the next unindexed page; GitHub failures propagate instead of disabling the index. */
  async function hydrate(entries: Entry[], cursor: number, budget: Budget) {
    const known = await indexed((database) =>
      database.titles(entries.slice(cursor).map((entry) => entry.sha)),
    );
    if (!known) return undefined;
    for (const [sha, title] of known) rememberTitle(sha, title);
    const page = await readPage(entries, cursor, (sha) => !known.has(sha), true, budget);
    if (
      page.bodies.length &&
      !(await indexed((database) => database.put(page.bodies).then(() => true)))
    )
      return undefined;
    return page.end;
  }
  /** One body via the cache, an in-flight GraphQL batch or the REST blob endpoint. */
  async function blob(sha: string) {
    const markdown = cached(sha);
    if (markdown !== undefined) return markdown;
    return (await loading.get(sha)) ?? restBlob(sha);
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
        for (const f of data.tree as { path: string; sha: string; type: string; size?: number }[]) {
          const id = f.type === "blob" && docPath.exec("docs/" + f.path)?.[1];
          if (id) entries.push({ id, sha: f.sha, size: f.size });
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
      // Known titles cost no GitHub request, so a page ends only at the read budget.
      const { end, bodies } = await readPage(
        docs,
        cursor,
        (sha) => !known.has(sha),
        indexUsable(),
        { left: PAGE_BUDGET },
      );
      for (const { sha, markdown } of bodies) known.set(sha, titleOf(markdown).slice(0, 512));
      if (bodies.length) await indexed((database) => database.put(bodies));
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
      if (!indexUsable()) unavailable();
      const entries = await snapshot();
      const ready = await indexed((database) => database.searchComplete(entries, query));
      if (ready) return { items: ready, next: null };
      if (ready === undefined) unavailable();
      // A cold index is hydrated one page per request to stay within the subrequest budget.
      const end = await hydrate(entries, cursor, { left: PAGE_BUDGET });
      if (end === undefined) unavailable();
      const last = end >= entries.length;
      if (last) {
        const complete = await indexed((database) => database.searchComplete(entries, query));
        if (complete) return { items: complete, next: null };
      }
      const page = entries.slice(cursor, end);
      const items = await indexed((database) => database.search(page, query));
      if (!items) unavailable();
      return { items, next: last ? null : end };
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
