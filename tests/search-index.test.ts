import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { SearchIndex, type IndexEntry } from "../apps/api/src/search-index.ts";
import { matchDocument, searchTerms, titleOf } from "../packages/shared/src/index.ts";
import { SqliteD1 } from "./sqlite.ts";
const credentials = { GITHUB_REPOSITORY: "u/repo", GITHUB_BRANCH: "main", GITHUB_TOKEN: "private" };
const sha = (n: number) => n.toString(16).padStart(40, "0");

test("FTS5 and literal substring semantics agree for Unicode, short terms and query operators", async () => {
  const db = new SqliteD1();
  try {
    const index = new SearchIndex(db, credentials);
    const docs = [
      "# API 保存\n日本語の検索とＡＰＩ保存",
      '# Work\nneedle foo_bar a%b foo* OR quoted"text C++',
      "# 😀🌙星\n👨‍👩‍👧‍👦 全角１２３",
      "# Mixed\nİSTANBUL ÄPFEL Café e\u0301",
    ];
    const entries = docs.map((markdown, id) => ({ id: String(id), sha: sha(id + 1) }));
    await index.put(docs.map((markdown, id) => ({ sha: sha(id + 1), markdown })));
    for (const query of [
      "検索",
      "日本語",
      "ＡＰＩ 保存",
      "a",
      "foo_bar",
      "a%b",
      "foo* OR",
      'quoted"text',
      "C++",
      "😀🌙星",
      "👨‍👩‍👧‍👦",
      "１２３",
      "äpfel",
      "Café",
      "e\u0301",
      "needle -missing",
      "' OR 1=1 --",
      "(",
      "\0",
    ]) {
      const expected = docs
        .map((markdown, id) =>
          matchDocument(String(id), titleOf(markdown), markdown, searchTerms(query)),
        )
        .filter(Boolean)
        .map((result) => result!.id)
        .sort();
      const actual = (await index.search(entries, query)).map((result) => result.id).sort();
      assert.deepEqual(actual, expected, query);
    }
    assert.equal(await index.contains(entries), true);
    assert.equal((await index.titles([sha(1)])).get(sha(1)), "API 保存");
  } finally {
    db.close();
  }
});

test("current tree joins exclude deleted documents and old versions, including reversed write completion", async () => {
  const db = new SqliteD1();
  try {
    const index = new SearchIndex(db, credentials);
    await index.put([{ sha: sha(2), markdown: "# New\nnew needle" }]);
    await index.put([{ sha: sha(1), markdown: "# Old\nstale needle" }]);
    const current = [{ id: "id", sha: sha(2) }];
    assert.deepEqual(
      (await index.search(current, "needle")).map((result) => result.title),
      ["New"],
    );
    assert.equal((await index.search(current, "stale")).length, 0);
    assert.equal((await index.search([], "needle")).length, 0);
    assert.equal(await index.contains([{ id: "id", sha: sha(3) }]), false);
    // Duplicate SHAs are separate document IDs, not lost by content-addressed storage.
    assert.equal(
      (await index.search([...current, { id: "copy", sha: sha(2) }], "needle")).length,
      2,
    );
  } finally {
    db.close();
  }
});

test("persistent index is scoped by repository, branch and a non-plaintext credential digest", async () => {
  const db = new SqliteD1();
  try {
    const first = new SearchIndex(db, credentials);
    await first.put([{ sha: sha(1), markdown: "# Private\nneedle" }]);
    const entry = [{ id: "id", sha: sha(1) }];
    for (const changed of [
      { ...credentials, GITHUB_TOKEN: "rotated" },
      { ...credentials, GITHUB_BRANCH: "other" },
      { ...credentials, GITHUB_REPOSITORY: "u/other" },
    ]) {
      assert.equal(await new SearchIndex(db, changed).contains(entry), false);
      assert.deepEqual(await new SearchIndex(db, changed).search(entry, "needle"), []);
    }
    const record = db.sqlite.prepare("SELECT scope FROM search_blobs").get()!;
    assert.match(String(record.scope), /^[0-9a-f]{64}$/);
    assert.notEqual(record.scope, credentials.GITHUB_TOKEN);
  } finally {
    db.close();
  }
});

test("queries keep bound variable counts bounded and titles rank ahead of body hits", async () => {
  const db = new SqliteD1();
  try {
    const index = new SearchIndex(db, credentials);
    const body = "# First\nneedle " + "x ".repeat(100);
    await index.put([
      { sha: sha(1), markdown: body },
      { sha: sha(2), markdown: "# Needle\nbody" },
    ]);
    const entries: IndexEntry[] = [
      { id: "1", sha: sha(1) },
      { id: "2", sha: sha(2) },
    ];
    assert.equal((await index.search(entries, "needle"))[0].id, "2");
    assert.equal((await index.search(entries, "x ".repeat(100))).length, 1);
    assert.ok((await index.search(entries, "needle"))[0].snippet.length <= 200);
    // Content-addressed writes are idempotent, even if two isolates race.
    await index.put([{ sha: sha(1), markdown: body }]);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM search_blobs").get()!.count, 2);
  } finally {
    db.close();
  }
});

const uuid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const ids = (results: { id: string }[] | null) => results?.map((result) => result.id).sort();

test("a synced tree is queried from current_docs without binding the tree, and cold isolates write no rows", async () => {
  const db = new SqliteD1();
  try {
    const count = 5_000;
    const entries = Array.from({ length: count }, (_, n) => ({ id: uuid(n), sha: sha(n + 1) }));
    const first = new SearchIndex(db, credentials);
    await first.put(
      entries.map((entry, n) => ({
        sha: entry.sha,
        markdown: `# Note ${n}\nbody ${n % 100 === 0 ? "needle" : "plain"}`,
      })),
    );
    const expected = entries.filter((_, n) => n % 100 === 0).map((entry) => entry.id);
    const treeBytes = JSON.stringify(entries.map(({ id, sha }) => [id, sha])).length;
    assert.ok(treeBytes > 400_000);

    let before = db.requests.length;
    assert.deepEqual(ids(await first.searchComplete(entries, "needle")), expected);
    const sync = db.requests.slice(before);
    assert.equal(sync.length, 1); // Replacement, check, completeness and search share one batch.
    // D1 limits: 100 KB per SQL statement, 2 MB per bound string or BLOB.
    assert.ok(sync[0].maxSql < 100_000 && sync[0].maxBound < 2_000_000);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM current_docs").get()!.n, count);

    before = db.requests.length;
    assert.deepEqual(ids(await first.searchComplete(entries, "needle")), expected);
    assert.equal(await first.contains(entries), true);
    for (const request of db.requests.slice(before)) assert.ok(request.bytes < 4_000);

    // A cold isolate re-sends the tree once, but rewrites nothing when the table is current.
    const changes = () => db.sqlite.prepare("SELECT total_changes() AS n").get()!.n as number;
    const written = changes();
    const cold = new SearchIndex(db, credentials);
    assert.deepEqual(ids(await cold.searchComplete([...entries].reverse(), "needle")), expected);
    assert.equal(changes(), written);

    const changed = entries.slice(1);
    assert.deepEqual(ids(await cold.searchComplete(changed, "needle")), expected.slice(1));
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM current_docs").get()!.n, count - 1);
  } finally {
    db.close();
  }
}, 30_000);

test("rows written for another isolate's tree are never used: the query falls back to the bound tree", async () => {
  const db = new SqliteD1();
  try {
    const index = new SearchIndex(db, credentials);
    await index.put([
      { sha: sha(1), markdown: "# A\nneedle" },
      { sha: sha(2), markdown: "# B\nneedle" },
    ]);
    const treeA = [{ id: "a", sha: sha(1) }];
    const treeB = [{ id: "b", sha: sha(2) }];
    const isolateA = new SearchIndex(db, credentials);
    const isolateB = new SearchIndex(db, credentials);
    assert.deepEqual(ids(await isolateA.searchComplete(treeA, "needle")), ["a"]);
    assert.deepEqual(ids(await isolateB.searchComplete(treeB, "needle")), ["b"]);
    // A still believes the table holds its tree; the version check rejects B's rows.
    let trips = db.roundTrips;
    assert.deepEqual(ids(await isolateA.searchComplete(treeA, "needle")), ["a"]);
    assert.equal(db.roundTrips - trips, 2); // Table attempt plus JSON fallback.
    // The next request re-syncs A's tree and uses the table again.
    assert.deepEqual(ids(await isolateA.searchComplete(treeA, "needle")), ["a"]);
    trips = db.roundTrips;
    assert.deepEqual(ids(await isolateA.searchComplete(treeA, "needle")), ["a"]);
    assert.equal(db.roundTrips - trips, 1);

    // Pruning by B's rows would delete A's current blob.
    assert.deepEqual(ids(await isolateB.searchComplete(treeB, "needle")), ["b"]);
    await isolateA.prune(treeA);
    assert.equal(await isolateA.contains(treeA), true);
    assert.equal(await isolateB.contains(treeB), false);
  } finally {
    db.close();
  }
});

test("concurrent isolates with different trees each get results for the tree they observed", async () => {
  const db = new SqliteD1();
  try {
    const all = Array.from({ length: 40 }, (_, n) => ({ id: uuid(n), sha: sha(n + 1) }));
    await new SearchIndex(db, credentials).put(
      all.map((entry, n) => ({ sha: entry.sha, markdown: `# Note ${n}\nneedle ${n}` })),
    );
    const trees = [all.slice(0, 10), all.slice(5, 30), all.slice(20), all.filter((_, n) => n % 3)];
    const isolates = Array.from({ length: 8 }, () => new SearchIndex(db, credentials));
    for (let round = 0; round < 6; round++) {
      await Promise.all(
        isolates.map(async (isolate, i) => {
          const tree = trees[(i + round) % trees.length];
          const results = await isolate.searchComplete(tree, "needle");
          assert.deepEqual(ids(results), tree.map((entry) => entry.id).sort());
          assert.equal(await isolate.contains(tree), true);
        }),
      );
    }
    // The table always describes exactly the tree its version names.
    const scope = db.sqlite.prepare("SELECT scope, version FROM tree_state").get()!;
    const rows = db.sqlite
      .prepare("SELECT id, sha FROM current_docs WHERE scope = ? ORDER BY id")
      .all(scope.scope as string)
      .map((row) => JSON.stringify([row.id, row.sha]));
    const described = trees.filter(
      (tree) =>
        JSON.stringify(tree.map(({ id, sha }) => JSON.stringify([id, sha]))) ===
        JSON.stringify(rows),
    );
    assert.equal(described.length, 1);
  } finally {
    db.close();
  }
});

test("a database without the current_docs migration keeps searching with the bound tree", async () => {
  const db = new SqliteD1();
  try {
    db.sqlite.exec("DROP TABLE current_docs");
    db.sqlite.exec("DROP TABLE tree_state");
    const index = new SearchIndex(db, credentials);
    await index.put([
      { sha: sha(1), markdown: "# One\nneedle" },
      { sha: sha(2), markdown: "# Old\nneedle" },
    ]);
    const tree = [{ id: "1", sha: sha(1) }];
    assert.deepEqual(ids(await index.searchComplete(tree, "needle")), ["1"]);
    const trips = db.roundTrips;
    assert.equal(await index.contains(tree), true);
    assert.equal(db.roundTrips - trips, 1); // The missing table is not retried on every request.
    await index.prune(tree);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM search_blobs").get()!.n, 1);
  } finally {
    db.close();
  }
});
