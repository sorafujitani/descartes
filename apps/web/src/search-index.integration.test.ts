import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { SearchIndex, type SearchDatabase } from "../../api/src/search-index.ts";

test("real workerd D1 supports the migration, trigram queries and immutable-version filtering", async () => {
  const mf = new Miniflare({
    enableDevRegistry: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "index-test",
          compatibilityDate: "2026-05-01",
          env: { SEARCH_DB: { type: "d1", id: "index-test" } },
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } }",
              },
            },
          },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database("SEARCH_DB");
    const migration = await readFile(
      new URL("../../api/migrations/0001_search.sql", import.meta.url),
      "utf8",
    );
    // Apply the same SQL used by the deployment migration, including real FTS triggers.
    await db.exec(
      migration
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n"),
    );
    const credentials = {
      GITHUB_REPOSITORY: "u/repo",
      GITHUB_BRANCH: "main",
      GITHUB_TOKEN: "fixture",
    };
    const first = new SearchIndex(db as unknown as SearchDatabase, credentials);
    const entry = { id: "id", sha: "1".repeat(40) };
    await first.put([{ sha: entry.sha, markdown: "# API 保存\n日本語・ＡＰＩ・trigram needle" }]);
    const restarted = new SearchIndex(db as unknown as SearchDatabase, credentials);
    assert.equal(await restarted.contains([entry]), true);
    assert.equal((await restarted.search([entry], "API 保存"))[0].title, "API 保存");
    assert.equal((await restarted.search([entry], "日本語 needle"))[0].id, entry.id);
    assert.equal((await restarted.search([entry], "語"))[0].id, entry.id);
    assert.equal((await restarted.search([{ ...entry, sha: "2".repeat(40) }], "needle")).length, 0);
    // Batched completeness check and search share one D1 round trip.
    assert.equal((await restarted.searchComplete([entry], "needle"))?.[0].id, entry.id);
    assert.equal(
      await restarted.searchComplete([entry, { id: "x", sha: "3".repeat(40) }], "needle"),
      null,
    );
    await restarted.put([{ sha: "4".repeat(40), markdown: "# Old\nneedle" }]);
    await restarted.prune([entry]);
    assert.equal(await restarted.contains([{ id: "old", sha: "4".repeat(40) }]), false);
    assert.equal((await restarted.search([entry], "needle"))[0].id, entry.id);
    await db.prepare("DELETE FROM search_blobs").run();
    assert.equal(await restarted.contains([entry]), false);
    assert.equal((await restarted.search([entry], "needle")).length, 0);
  } finally {
    await mf.dispose();
  }
}, 20_000);
