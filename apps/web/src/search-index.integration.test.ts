import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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
    // Apply the same SQL, in order, as the deployment migrations, including real FTS triggers.
    const migrations = new URL("../../api/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort())
      await db.exec(
        (await readFile(new URL(name, migrations), "utf8"))
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
    // A whole-tree check syncs the observed tree into current_docs.
    assert.equal((await restarted.searchComplete([entry], "needle"))?.[0].id, entry.id);
    const rows = await db.prepare("SELECT id, sha FROM current_docs").all();
    assert.deepEqual(rows.results, [entry]);
    // Another isolate replaces the rows; this one must fall back instead of using them.
    const other = { id: "other", sha: "5".repeat(40) };
    await restarted.put([{ sha: other.sha, markdown: "# Other\nneedle" }]);
    const isolate = new SearchIndex(db as unknown as SearchDatabase, credentials);
    assert.equal((await isolate.searchComplete([other], "needle"))?.[0].id, other.id);
    assert.equal((await restarted.searchComplete([entry], "needle"))?.[0].id, entry.id);
    const many = Array.from({ length: 5_000 }, (_, n) => ({
      id: `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`,
      sha: n ? n.toString(16).padStart(40, "a") : entry.sha,
    }));
    // Incomplete (most SHAs are not indexed), but a 5,000-note tree fits D1's limits.
    assert.equal(await isolate.searchComplete(many, "needle"), null);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM current_docs").first())?.n, 5_000);
    await db.prepare("DELETE FROM search_blobs").run();
    assert.equal(await restarted.contains([entry]), false);
    assert.equal((await restarted.search([entry], "needle")).length, 0);
  } finally {
    await mf.dispose();
  }
}, 20_000);
