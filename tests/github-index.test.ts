import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { github, type Env } from "../apps/api/src/github.ts";
import { client } from "../packages/shared/src/index.ts";
import { route } from "./support.ts";
import { SqliteD1 } from "./sqlite.ts";

const idOf = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const shaOf = (n: number) => n.toString(16).padStart(40, "0");
function fixture(db: SqliteD1, count = 65) {
  let clock = 0,
    revision = 1000;
  const env: Env = {
    GITHUB_REPOSITORY: "u/index-fixture",
    GITHUB_BRANCH: "main",
    GITHUB_TOKEN: "fixture",
    ACCESS_AUD: "test",
    ACCESS_ISSUER: "https://test.invalid",
    SEARCH_DB: db,
  };
  const docs = new Map(
    Array.from({ length: count }, (_, n) => [
      idOf(n),
      { sha: shaOf(n + 1), markdown: `# Note ${n}\nbody needle 検索 ${n}` },
    ]),
  );
  const counts = { metadata: 0, tree: 0, blobs: 0, writes: 0 };
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("index-fixture")) {
      counts.metadata++;
      return Response.json({ private: true });
    }
    if (url.pathname.includes("/git/trees/")) {
      counts.tree++;
      return Response.json({
        tree: [...docs].map(([id, doc]) => ({ path: `docs/${id}.md`, sha: doc.sha, type: "blob" })),
      });
    }
    if (url.pathname.includes("/git/blobs/")) {
      counts.blobs++;
      const doc = [...docs.values()].find((doc) => url.pathname.endsWith(doc.sha))!;
      return Response.json({
        encoding: "base64",
        content: Buffer.from(doc.markdown).toString("base64"),
      });
    }
    const id = url.pathname.split("/").at(-1)!.slice(0, -3);
    if (init?.method === "PUT") {
      counts.writes++;
      const body = JSON.parse(String(init.body));
      if (body.sha !== docs.get(id)?.sha) return new Response(null, { status: 409 });
      const doc = {
        sha: shaOf(++revision),
        markdown: Buffer.from(body.content, "base64").toString(),
      };
      docs.set(id, doc);
      return Response.json({ content: { sha: doc.sha } });
    }
    const doc = docs.get(id)!;
    return Response.json({
      sha: doc.sha,
      encoding: "base64",
      content: Buffer.from(doc.markdown).toString("base64"),
    });
  };
  return {
    counts,
    docs,
    env,
    send,
    fresh: () => github(env, send, () => clock),
    advance: () => {
      clock += 30_001;
    },
    external: (id: string, markdown: string) => docs.set(id, { sha: shaOf(++revision), markdown }),
  };
}
const apiFor = (store: ReturnType<typeof github>, count: () => void = () => {}) =>
  client("https://app.test", {}, async (input, init) => {
    count();
    return route(new Request(String(input), init), store);
  });

test("persistent index survives adapter restarts and completes fully indexed searches in a single page", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db);
    let coldPages = 0;
    const started = performance.now();
    const first = await apiFor(f.fresh(), () => coldPages++).search("needle");
    const coldMs = performance.now() - started;
    assert.equal(first.items.length, 50);
    assert.equal(f.counts.blobs, 65);
    assert.equal(coldPages, 5);
    const beforeBlobs = f.counts.blobs;
    let persistedPages = 0;
    const nextStarted = performance.now();
    const second = await apiFor(f.fresh(), () => persistedPages++).search("検索");
    const persistedMs = performance.now() - nextStarted;
    assert.equal(second.items.length, 50);
    assert.equal(f.counts.blobs, beforeBlobs);
    assert.equal(persistedPages, 1);
    const listed = await f.fresh().list(0);
    assert.equal(listed.items.length, 16);
    assert.equal(f.counts.blobs, beforeBlobs);
    if (process.env.DESCARTES_BENCHMARK === "1")
      console.info(
        JSON.stringify({
          fixture: "65 synthetic documents, local SQLite (not production)",
          cold: { httpRequests: coldPages, githubBlobs: beforeBlobs, elapsedMs: coldMs },
          persistedColdWorker: {
            httpRequests: persistedPages,
            githubBlobs: f.counts.blobs - beforeBlobs,
            elapsedMs: persistedMs,
          },
        }),
      );
  } finally {
    db.close();
  }
});

test("SHA reconciliation handles renames, deleted files and external edits without serving stale indexed bodies", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db, 2);
    const store = f.fresh();
    await apiFor(store).search("needle");
    f.external(idOf(0), "# Renamed\nnew content");
    f.docs.delete(idOf(1));
    f.advance();
    assert.equal((await apiFor(store).search("needle")).items.length, 0);
    assert.equal((await apiFor(store).search("new content")).items[0].title, "Renamed");
    assert.equal(f.counts.blobs, 3); // Only the changed SHA is fetched, not the deleted/unchanged versions.
    const read = await store.get(idOf(0));
    const saved = await store.save(read.id, "# Saved\nimmediate index", read.sha);
    assert.equal((await apiFor(f.fresh()).search("immediate")).items[0].id, saved.id);
  } finally {
    db.close();
  }
});

test("an unavailable or unmigrated index falls back, and never reports a successful commit as a failed save", async () => {
  const db = new SqliteD1();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const f = fixture(db, 1);
    db.sqlite.exec("DROP TABLE search_fts");
    // A missing migration/table can fail on either read or write.
    db.sqlite.exec("DROP TRIGGER search_blobs_insert");
    db.sqlite.exec("DROP TRIGGER search_blobs_delete");
    db.sqlite.exec("DROP TABLE search_blobs");
    const store = f.fresh();
    const read = await store.get(idOf(0));
    const saved = await store.save(read.id, "# Successfully committed\nbody", read.sha);
    assert.notEqual(saved.sha, read.sha);
    assert.equal(f.counts.writes, 1);
    assert.equal((await apiFor(store).search("committed")).items[0].title, saved.title);
    assert.equal(warning.mock.calls.length, 1); // Failure backoff avoids retry storms.
    assert.doesNotMatch(JSON.stringify(warning.mock.calls), /Successfully|fixture|needle/);
  } finally {
    warning.mockRestore();
    db.close();
  }
});

test("reading an old SHA after a newer save cannot replace the current indexed document", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db, 1);
    const store = f.fresh();
    const original = await store.get(idOf(0));
    const updated = await store.save(original.id, "# Current\ncurrent-term", original.sha);
    // Reconcile an old reader into the same DB after the newer write completed.
    const old = new (await import("../apps/api/src/search-index.ts")).SearchIndex(db, f.env);
    await old.put([{ sha: original.sha, markdown: original.markdown }]);
    const result = await apiFor(f.fresh()).search("current-term");
    assert.equal(result.items[0].title, updated.title);
    assert.equal((await apiFor(f.fresh()).search("needle")).items.length, 0);
  } finally {
    db.close();
  }
});
