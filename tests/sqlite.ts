import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { SearchDatabase, SearchStatement } from "../apps/api/src/search-index.ts";

/** Exercises real SQLite/FTS5 SQL, not a mock that infers behavior from query strings. */
export class SqliteD1 implements SearchDatabase {
  readonly sqlite = new DatabaseSync(":memory:");
  queries = 0;
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
        return {
          results: this.sqlite
            .prepare(sql)
            .all(...(values as SQLInputValue[]))
            .map((row) => ({ ...row })) as T[],
        };
      },
      run: async () => {
        this.queries++;
        return this.sqlite.prepare(sql).run(...(values as SQLInputValue[]));
      },
    });
    return execute([]);
  }
  async batch(statements: SearchStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
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
