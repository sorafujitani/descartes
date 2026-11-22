import { normalizeSearch, searchTerms, titleOf, type SearchResult } from "@descartes/shared";

/** Minimal structural D1 contract; no Worker globals leak into browser/client types. */
export interface SearchStatement {
  bind(...values: unknown[]): SearchStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface SearchDatabase {
  prepare(sql: string): SearchStatement;
  batch(statements: SearchStatement[]): Promise<unknown[]>;
}
export type IndexEntry = { id: string; sha: string };
export type IndexBlob = { sha: string; markdown: string };
const entriesJson = (entries: IndexEntry[]) =>
  JSON.stringify(entries.map(({ id, sha }) => [id, sha]));
const entryId = "json_extract(e.value, '$[0]')";
const entrySha = "json_extract(e.value, '$[1]')";
const heading = `(CASE WHEN b.title = '' THEN ${entryId} ELSE b.normalized_title END)`;

export class SearchIndex {
  private scope: Promise<string>;
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
  async contains(entries: IndexEntry[]) {
    if (!entries.length) return true;
    const { results } = await this.db
      .prepare(`SELECT count(*) AS count FROM json_each(?) e
      JOIN search_blobs b ON b.scope = ? AND b.sha = ${entrySha}`)
      .bind(entriesJson(entries), await this.scope)
      .all<{ count: number }>();
    return results[0].count === entries.length;
  }
  async put(blobs: IndexBlob[]) {
    const scope = await this.scope;
    const sql = `INSERT INTO search_blobs(scope, sha, title, normalized_title, markdown, search_text)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, sha) DO NOTHING`;
    let batch: SearchStatement[] = [];
    let bytes = 0;
    for (const { sha, markdown } of blobs) {
      const title = titleOf(markdown).slice(0, 512);
      const text = normalizeSearch(markdown);
      const size =
        new TextEncoder().encode(markdown).length +
        new TextEncoder().encode(text).length +
        title.length * 4 +
        256;
      // Bound batch payloads; pathological normalization expansion falls back to the canonical reader.
      if (size > 2 * 1024 * 1024) throw new Error("Document exceeds index row budget.");
      if (bytes + size > 2 * 1024 * 1024 && batch.length) {
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
  }
  async search(entries: IndexEntry[], query: string): Promise<SearchResult[]> {
    const terms = searchTerms(query);
    if (!entries.length || !terms.length) return [];
    const titleMatches = `NOT EXISTS (SELECT 1 FROM json_each(?) t WHERE instr(${heading}, t.value) = 0)`;
    const matches = `NOT EXISTS (SELECT 1 FROM json_each(?) t WHERE instr(b.search_text, t.value) = 0 AND instr(${heading}, t.value) = 0)`;
    const long = terms.filter((term) => [...term].length >= 3 && !term.includes("\0"));
    const trigram = long.length
      ? `AND (b.rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?) OR b.title = '')`
      : "";
    const sql = `SELECT ${entryId} AS id, CASE WHEN b.title = '' THEN ${entryId} ELSE b.title END AS title,
      substr(b.markdown, CASE WHEN instr(b.markdown, char(10)) > 0 THEN instr(b.markdown, char(10)) + 1 ELSE length(b.markdown) + 1 END, 200) AS snippet,
      CASE WHEN ${titleMatches} THEN 0 ELSE 1 END AS rank
      FROM json_each(?) e JOIN search_blobs b ON b.scope = ? AND b.sha = ${entrySha}
      WHERE ${matches} ${trigram} ORDER BY rank, title COLLATE NOCASE, id LIMIT 50`;
    const params: unknown[] = [
      JSON.stringify(terms),
      entriesJson(entries),
      await this.scope,
      JSON.stringify(terms),
    ];
    if (long.length)
      params.push(long.map((term) => '"' + term.replaceAll('"', '""') + '"').join(" AND "));
    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all<SearchResult>();
    return results;
  }
}
