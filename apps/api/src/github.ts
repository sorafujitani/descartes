import { titleOf, searchTerms, type Document } from "@descartes/shared";
import { mapConcurrent, semaphore } from "./concurrency.ts";
import { base64, decode, githubHttp, graphqlBlobs } from "./github-http.ts";
import { Lru } from "./lru.ts";
import { fail, type Repository } from "./repository.ts";
import {
  INDEX_BATCH_BYTES,
  indexRow,
  SearchIndex,
  type SearchDatabase,
  type IndexBlob,
  type IndexRow,
} from "./search-index.ts";
import { SingleFlight } from "./single-flight.ts";
import { documentTree, type Entry } from "./tree.ts";
export { fail, HttpError } from "./repository.ts";
export interface Env {
  GITHUB_REPOSITORY: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN: string;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
  SEARCH_DB?: SearchDatabase;
}
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
type Budget = { left: number };
type Loaded = IndexBlob | IndexRow;
export type GitHubRepository = Repository & {
  /** Background index maintenance for the cron handler; deliberately not part of the HTTP API. */
  warm(blobBudget?: number): Promise<WarmReport>;
};

/** One adapter per repository/credential/branch, retained by the Worker (never a public HTTP cache). */
export function github(env: Env, send: typeof fetch = fetch, now = Date.now): GitHubRepository {
  const { request, call } = githubHttp(env, send);
  const ref = encodeURIComponent(env.GITHUB_BRANCH || "main");
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
  const titles = new Lru<string, string>(4096);
  // UTF-16 code units approximate the isolate memory held by each string.
  const contents = new Lru<string, string>(1024, CONTENT_BUDGET, (markdown) => markdown.length * 2);
  // `undefined`: GraphQL returned no usable text, so the REST blob endpoint must be used.
  const loading = new SingleFlight<string, string | undefined>();
  const restLoading = new SingleFlight<string, string>();
  // Immutable SHAs that GraphQL cannot serve (binary, truncated or undecidable) go straight to REST.
  const restOnly = new Set<string>();
  const blobSlot = semaphore(CONCURRENCY);
  const each = <T, R>(items: T[], fn: (item: T) => Promise<R>) =>
    mapConcurrent(CONCURRENCY, items, fn);
  const tree = documentTree(call, env.GITHUB_BRANCH || "main", now, async (entries) => {
    if (now() - prunedAt < PRUNE_INTERVAL) return;
    prunedAt = now();
    // A save racing this tree read may lose its fresh row; that only costs one re-fetch.
    await indexed((database) => database.prune(entries));
  });
  const checkingPrivate = new SingleFlight<"repo", void>();
  // Only a confirmed private=true result is reused, and only by reads.
  let privateUntil = -Infinity;
  let writes: Promise<unknown> = Promise.resolve();
  function remember(sha: string, markdown: string) {
    titles.set(sha, titleOf(markdown).slice(0, 512));
    if (!contents.has(sha)) contents.set(sha, markdown);
  }
  function cached(sha: string) {
    const markdown = contents.get(sha);
    if (markdown === undefined) return undefined;
    if (!titles.has(sha)) remember(sha, markdown);
    contents.touch(sha);
    return markdown;
  }
  function restBlob(sha: string) {
    return restLoading.run(sha, undefined, async () => {
      const data = await blobSlot(async () => (await call("/git/blobs/" + sha)).json());
      if (data.encoding && data.encoding !== "base64") fail(502, "Invalid GitHub blob encoding.");
      const markdown = decode(data.content);
      remember(sha, markdown);
      return markdown;
    });
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
        markdown === undefined ? (loading.peek(sha) ?? restLoading.peek(sha)) : undefined;
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
      const read = blobSlot(() => graphqlBlobs(request, env.GITHUB_REPOSITORY, shas));
      shas.forEach((sha, i) => {
        // Callers observe the shared promise through peek(); this handle only keeps it registered.
        loading
          .run(sha, undefined, () =>
            read.then((texts) => {
              const text = texts[i];
              if (text === undefined) {
                restOnly.add(sha);
                if (restOnly.size > 4096) restOnly.delete(restOnly.values().next().value!);
              } else remember(sha, text);
              return text;
            }),
          )
          .catch(() => {});
      });
    }
    for (const item of planned) item.body ??= loading.peek(item.sha);
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
    for (const [sha, title] of known) titles.set(sha, title);
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
    return (await loading.peek(sha)) ?? restBlob(sha);
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
        tree.invalidate();
      }
    });
    writes = result.catch(() => {});
    return result;
  }
  async function privateOnly({ fresh = false } = {}) {
    // A short success-only window removes a GitHub round trip from most reads; writes never use it.
    if (!fresh && now() < privateUntil) return;
    await checkingPrivate.run("repo", undefined, async () => {
      try {
        if ((await (await call("")).json()).private !== true)
          fail(403, "A private document repository is required.");
        privateUntil = now() + PRIVACY_TTL;
      } catch (error) {
        privateUntil = -Infinity;
        throw error;
      }
    });
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
      const entries = await tree.read();
      report.documents = entries.length;
      // The tree read may already have pruned; otherwise prune here so every run bounds the table.
      if (prunedAt === prunedBefore) {
        prunedAt = now();
        await indexed((database) => database.prune(entries));
      }
      const known = await indexed((database) => database.titles(entries.map((e) => e.sha)));
      if (!known) return { ...report, remaining: entries.length };
      for (const [sha, title] of known) titles.set(sha, title);
      const missing = [...new Set(entries.map((e) => e.sha).filter((sha) => !known.has(sha)))];
      const batch = missing.slice(0, Math.max(0, blobBudget));
      report.remaining = missing.length - batch.length;
      for (let i = 0; i < batch.length; i += WARM_CHUNK) {
        const loaded = await each(batch.slice(i, i + WARM_CHUNK), async (sha) => {
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
      const docs = await tree.read();
      const known = new Map<string, string>();
      for (const entry of docs.slice(cursor)) {
        const title = titles.get(entry.sha);
        if (title !== undefined) known.set(entry.sha, title);
      }
      const unknown = docs.slice(cursor).filter((entry) => !known.has(entry.sha));
      const stored = await indexed((database) => database.titles(unknown.map((e) => e.sha)));
      for (const [sha, title] of stored ?? []) {
        titles.set(sha, title);
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
      const entries = await tree.read();
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
      const entry = (await tree.read()).find((e) => e.id === id);
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
