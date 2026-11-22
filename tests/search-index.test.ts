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
