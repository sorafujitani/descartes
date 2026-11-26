import { normalizeSearch, searchTerms, titleOf, type SearchResult } from "@descartes/shared";

/** Minimal structural D1 contract; no Worker globals leak into browser/client types. */
export interface SearchStatement {
  bind(...values: unknown[]): SearchStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface SearchDatabase {
  prepare(sql: string): SearchStatement;
  /** One round trip; like D1, each result carries the rows of its statement. */
  batch(statements: SearchStatement[]): Promise<{ results?: unknown[] }[]>;
}
export type IndexEntry = { id: string; sha: string };
export type IndexBlob = { sha: string; markdown: string };
export type IndexRow = IndexBlob & { title: string; text: string; size: number };
/** `put` flushes a D1 batch before it would exceed this many bytes. */
export const INDEX_BATCH_BYTES = 2 * 1024 * 1024;
/** Precomputed so callers can count D1 batches before writing without normalizing twice. */
export function indexRow({ sha, markdown }: IndexBlob): IndexRow {
  const title = titleOf(markdown).slice(0, 512);
  const text = normalizeSearch(markdown);
  const size =
    new TextEncoder().encode(markdown).length +
    new TextEncoder().encode(text).length +
    title.length * 4 +
    256;
  return { sha, markdown, title, text, size };
}
const isRow = (blob: IndexBlob | IndexRow): blob is IndexRow => "size" in blob;
const entriesJson = (entries: IndexEntry[]) =>
  JSON.stringify(entries.map(({ id, sha }) => [id, sha]));
/** Rows describing the current tree, exposed as `e(id, sha)`. */
type Source = { sql: string; params: unknown[]; guard: string; guardParams: unknown[] };
const jsonSource = (entries: IndexEntry[]): Source => ({
  sql: "(SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS sha FROM json_each(?))",
  params: [entriesJson(entries)],
  guard: "1",
  guardParams: [],
});
const currentTree = "EXISTS (SELECT 1 FROM tree_state WHERE scope = ? AND version = ?)";
const tableSource = (scope: string, version: string): Source => ({
  sql: "(SELECT id, sha FROM current_docs WHERE scope = ?)",
  params: [scope],
  guard: currentTree,
  guardParams: [scope, version],
});
const heading = "(CASE WHEN b.title = '' THEN e.id ELSE b.normalized_title END)";
// Well below D1's 2 MB bound-string limit, assuming up to 3 UTF-8 bytes per UTF-16 unit.
const CHUNK_BYTES = 1024 * 1024;
const TABLE_RETRY_MS = 10 * 60_000;

export class SearchIndex {
  private scope: Promise<string>;
  /** Tree version this instance last saw in `current_docs`. */
  private synced?: string;
  private hashed?: { json: string; version: string };
  private tableRetryAt = 0;
  constructor(
    private db: SearchDatabase,
    credentials: { GITHUB_REPOSITORY: string; GITHUB_BRANCH: string; GITHUB_TOKEN: string },
  ) {
    // Rotating a credential never reuses another credential's cached documents. No token is stored in D1.
    this.scope = crypto.subtle
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            credentials.GITHUB_REPOSITORY,
            credentials.GITHUB_BRANCH || "main",
            credentials.GITHUB_TOKEN,
          ]),
        ),
      )
      .then((hash) =>
        Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      );
  }
  async titles(shas: string[]): Promise<Map<string, string>> {
    if (!shas.length) return new Map();
    const { results } = await this.db
      .prepare(`SELECT sha, title FROM search_blobs
      WHERE scope = ? AND sha IN (SELECT value FROM json_each(?))`)
      .bind(await this.scope, JSON.stringify([...new Set(shas)]))
      .all<{ sha: string; title: string }>();
    return new Map(results.map(({ sha, title }) => [sha, title]));
  }
  /** Immutable body of one blob, so a cold isolate can open a document without GitHub reads. */
  async markdown(sha: string): Promise<string | undefined> {
    const { results } = await this.db
      .prepare(`SELECT markdown FROM search_blobs WHERE scope = ? AND sha = ?`)
      .bind(await this.scope, sha)
      .all<{ markdown: string }>();
    return results[0]?.markdown;
  }
  /** Hash of the sorted tree; identifies which tree the `current_docs` rows describe. */
  private async version(entries: IndexEntry[]) {
    const json = entriesJson([...entries].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
    if (this.hashed?.json === json) return this.hashed.version;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const version = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    this.hashed = { json, version };
    return version;
  }
  /**
   * Replaces the scope's rows with `entries` unless they already describe `version`, so a cold
   * isolate observing an unchanged tree writes no rows.
   */
  private replace(scope: string, entries: IndexEntry[], version: string) {
    const statements = [
      this.db
        .prepare(`DELETE FROM current_docs WHERE scope = ? AND NOT ${currentTree}`)
        .bind(scope, scope, version),
    ];
    const insert = `INSERT INTO current_docs(scope, id, sha)
      SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
      WHERE NOT ${currentTree}`;
    let chunk: IndexEntry[] = [];
    let bytes = 0;
    for (const entry of entries) {
      const size = (entry.id.length + entry.sha.length + 8) * 3;
      if (bytes + size > CHUNK_BYTES && chunk.length) {
        statements.push(this.db.prepare(insert).bind(scope, entriesJson(chunk), scope, version));
        chunk = [];
        bytes = 0;
      }
      chunk.push(entry);
      bytes += size;
    }
    if (chunk.length)
      statements.push(this.db.prepare(insert).bind(scope, entriesJson(chunk), scope, version));
    statements.push(
      this.db
        .prepare(`INSERT INTO tree_state(scope, version) VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET version = excluded.version
        WHERE tree_state.version <> excluded.version`)
        .bind(scope, version),
    );
    return statements;
  }
  /**
   * Runs `build` in one batch against the current tree. Uses the `current_docs` table when it
   * describes exactly `entries`; otherwise binds the whole tree as JSON, which is always correct
   * but grows with the number of notes.
   */
  private async inTree(entries: IndexEntry[], build: (source: Source) => SearchStatement[]) {
    const scope = await this.scope;
    if (Date.now() >= this.tableRetryAt) {
      try {
        const version = await this.version(entries);
        const replace = this.synced === version ? [] : this.replace(scope, entries, version);
        const check = this.db.prepare("SELECT version FROM tree_state WHERE scope = ?").bind(scope);
        const results = await this.db.batch([
          ...replace,
          check,
          ...build(tableSource(scope, version)),
        ]);
        const [state, ...rest] = results.slice(replace.length);
        // A batch is one transaction, so the check holds for every statement after it.
        if ((state.results?.[0] as { version?: string } | undefined)?.version === version) {
          this.synced = version;
          return rest;
        }
        // Another isolate replaced the rows with its tree after our last sync.
        this.synced = undefined;
      } catch {
        // 0002 not migrated yet, or the table is unavailable: behave as before it existed.
        this.synced = undefined;
        this.tableRetryAt = Date.now() + TABLE_RETRY_MS;
      }
    }
    return this.db.batch(build(jsonSource(entries)));
  }
  private containsStatement(source: Source, scope: string) {
    return this.db
      .prepare(`SELECT count(*) AS count FROM ${source.sql} e
      JOIN search_blobs b ON b.scope = ? AND b.sha = e.sha`)
      .bind(...source.params, scope);
  }
  async contains(entries: IndexEntry[]) {
    if (!entries.length) return true;
    const scope = await this.scope;
    const [count] = await this.inTree(entries, (source) => [this.containsStatement(source, scope)]);
    return (count.results?.[0] as { count: number } | undefined)?.count === entries.length;
  }
  /** Deletes versions that are no longer in the tree, so the table and FTS index stop growing. */
  async prune(entries: IndexEntry[]) {
    const scope = await this.scope;
    await this.inTree(entries, (source) => [
      // Prune only by the tree this request observed, never by rows another isolate wrote.
      this.db
        .prepare(`DELETE FROM search_blobs WHERE scope = ? AND ${source.guard}
        AND sha NOT IN (SELECT e.sha FROM ${source.sql} e)`)
        .bind(scope, ...source.guardParams, ...source.params),
    ]);
  }
  /** Stores `blobs`, skipping documents too large for one row; returns how many were skipped. */
  async put(blobs: (IndexBlob | IndexRow)[]) {
    const scope = await this.scope;
    let oversized = 0;
    const sql = `INSERT INTO search_blobs(scope, sha, title, normalized_title, markdown, search_text)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, sha) DO NOTHING`;
    let batch: SearchStatement[] = [];
    let bytes = 0;
    for (const blob of blobs) {
      const { sha, markdown, title, text, size } = isRow(blob) ? blob : indexRow(blob);
      // Bound batch payloads. An oversized document stays unindexed instead of failing the batch,
      // which would otherwise block every other document in it on each retry.
      if (size > INDEX_BATCH_BYTES) {
        oversized++;
        continue;
      }
      if (bytes + size > INDEX_BATCH_BYTES && batch.length) {
        await this.db.batch(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(
        this.db.prepare(sql).bind(scope, sha, title, normalizeSearch(title), markdown, text),
      );
      bytes += size;
    }
    if (batch.length) await this.db.batch(batch);
    // A count only: never titles, paths or bodies.
    if (oversized) console.warn(JSON.stringify({ event: "search_index_oversized", oversized }));
    return oversized;
  }
  private searchStatement(source: Source, scope: string, terms: string[]) {
    const titleMatches = `NOT EXISTS (SELECT 1 FROM json_each(?) t WHERE instr(${heading}, t.value) = 0)`;
    const matches = `NOT EXISTS (SELECT 1 FROM json_each(?) t WHERE instr(b.search_text, t.value) = 0 AND instr(${heading}, t.value) = 0)`;
    const long = terms.filter((term) => [...term].length >= 3 && !term.includes("\0"));
    const trigram = long.length
      ? `AND (b.rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?) OR b.title = '')`
      : "";
    const sql = `SELECT e.id AS id, CASE WHEN b.title = '' THEN e.id ELSE b.title END AS title,
      substr(b.markdown, CASE WHEN instr(b.markdown, char(10)) > 0 THEN instr(b.markdown, char(10)) + 1 ELSE length(b.markdown) + 1 END, 200) AS snippet,
      CASE WHEN ${titleMatches} THEN 0 ELSE 1 END AS rank
      FROM ${source.sql} e JOIN search_blobs b ON b.scope = ? AND b.sha = e.sha
      WHERE ${matches} ${trigram} ORDER BY rank, title COLLATE NOCASE, id LIMIT 50`;
    const params: unknown[] = [
      JSON.stringify(terms),
      ...source.params,
      scope,
      JSON.stringify(terms),
    ];
    if (long.length)
      params.push(long.map((term) => '"' + term.replaceAll('"', '""') + '"').join(" AND "));
    return this.db.prepare(sql).bind(...params);
  }
  /** Searches only `entries` (a bounded page), always bound as JSON. */
  async search(entries: IndexEntry[], query: string): Promise<SearchResult[]> {
    const terms = searchTerms(query);
    if (!entries.length || !terms.length) return [];
    const { results } = await this.searchStatement(
      jsonSource(entries),
      await this.scope,
      terms,
    ).all<SearchResult>();
    return results;
  }
  /**
   * Checks completeness and searches the whole tree in one D1 round trip. Returns `null` while
   * some current document is not indexed yet, because partial results would silently miss matches.
   */
  async searchComplete(entries: IndexEntry[], query: string): Promise<SearchResult[] | null> {
    const terms = searchTerms(query);
    if (!entries.length || !terms.length) return [];
    const scope = await this.scope;
    const [count, found] = await this.inTree(entries, (source) => [
      this.containsStatement(source, scope),
      this.searchStatement(source, scope, terms),
    ]);
    if ((count.results?.[0] as { count: number } | undefined)?.count !== entries.length)
      return null;
    return (found.results ?? []) as SearchResult[];
  }
}
