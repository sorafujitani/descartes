import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { SearchDatabase, SearchStatement } from "../apps/api/src/search-index.ts";

type Statement = SearchStatement & { rows(): Record<string, unknown>[] };
/** Payload of one D1 round trip, to compare with D1's statement and bound-value limits. */
export type Request = { statements: number; bytes: number; maxSql: number; maxBound: number };

/** Exercises real SQLite/FTS5 SQL, not a mock that infers behavior from query strings. */
export class SqliteD1 implements SearchDatabase {
  readonly sqlite = new DatabaseSync(":memory:");
  queries = 0;
  /** D1 round trips: each standalone statement, or one per batch. */
  roundTrips = 0;
  requests: Request[] = [];
  constructor() {
    const migrations = new URL("../apps/api/migrations/", import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      this.sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  private measure(request: Request, sql: string, values: unknown[]) {
    const bytes = (value: unknown) =>
      typeof value === "string" ? Buffer.byteLength(value) : String(value).length;
    request.statements++;
    request.maxSql = Math.max(request.maxSql, bytes(sql));
    request.maxBound = Math.max(request.maxBound, ...values.map(bytes), 0);
    request.bytes += bytes(sql) + values.reduce<number>((sum, value) => sum + bytes(value), 0);
  }
  private request(): Request {
    const request = { statements: 0, bytes: 0, maxSql: 0, maxBound: 0 };
    this.roundTrips++;
    this.requests.push(request);
    return request;
  }
  prepare(sql: string): SearchStatement {
    const execute = (values: unknown[]): Statement => {
      const rows = (request: Request) => {
        this.queries++;
        this.measure(request, sql, values);
        return this.sqlite
          .prepare(sql)
          .all(...(values as SQLInputValue[]))
          .map((row) => ({ ...row }));
      };
      return {
        bind: (...values: unknown[]) => execute(values),
        rows: () => rows(this.requests.at(-1)!),
        all: async <T>() => ({ results: rows(this.request()) as T[] }),
        run: async () => {
          rows(this.request());
          return {};
        },
      };
    };
    return execute([]);
  }
  /** Runs synchronously, so concurrent callers interleave only between batches, as D1 serializes them. */
  async batch(statements: SearchStatement[]) {
    this.request();
    this.sqlite.exec("BEGIN");
    try {
      // D1 returns each statement's rows; INSERT/DELETE simply have none.
      const results = statements.map((statement) => ({ results: (statement as Statement).rows() }));
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.sqlite.close();
  }
}
