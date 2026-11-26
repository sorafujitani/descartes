import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { SearchDatabase, SearchStatement } from "../apps/api/src/search-index.ts";

/** Exercises real SQLite/FTS5 SQL, not a mock that infers behavior from query strings. */
export class SqliteD1 implements SearchDatabase {
  readonly sqlite = new DatabaseSync(":memory:");
  queries = 0;
  /** D1 round trips: each standalone statement, or one per batch. */
  roundTrips = 0;
  private batching = false;
  constructor() {
    this.sqlite.exec(
      readFileSync(new URL("../apps/api/migrations/0001_search.sql", import.meta.url), "utf8"),
    );
  }
  prepare(sql: string): SearchStatement {
    const execute = (values: unknown[]) => ({
      bind: (...values: unknown[]) => execute(values),
      all: async <T>() => {
        this.queries++;
        if (!this.batching) this.roundTrips++;
        return {
          results: this.sqlite
            .prepare(sql)
            .all(...(values as SQLInputValue[]))
            .map((row) => ({ ...row })) as T[],
        };
      },
      run: async () => {
        this.queries++;
        if (!this.batching) this.roundTrips++;
        return this.sqlite.prepare(sql).run(...(values as SQLInputValue[]));
      },
    });
    return execute([]);
  }
  async batch(statements: SearchStatement[]) {
    this.roundTrips++;
    this.batching = true;
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      // D1 returns each statement's rows; INSERT/DELETE simply have none.
      for (const statement of statements) results.push(await statement.all());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      this.batching = false;
    }
  }
  close() {
    this.sqlite.close();
  }
}
