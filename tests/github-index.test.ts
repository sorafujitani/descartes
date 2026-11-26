import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { github, type Env } from "../apps/api/src/github.ts";
import { client } from "../packages/shared/src/index.ts";
import { answerGraphql, blobLookups, route } from "./support.ts";
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
  // `blobs`: blobs read (GraphQL lookups and REST); `graphql`: batched GraphQL requests.
  const counts = { metadata: 0, tree: 0, blobs: 0, graphql: 0, writes: 0, contents: 0 };
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("index-fixture")) {
      counts.metadata++;
      return Response.json({ private: true });
    }
    if (url.pathname.includes("/git/trees/")) {
      counts.tree++;
      return Response.json({
        tree: [...docs].map(([id, doc]) => ({
          path: `${id}.md`,
          sha: doc.sha,
          type: "blob",
          size: Buffer.byteLength(doc.markdown),
        })),
      });
    }
    if (url.pathname === "/graphql") {
      counts.graphql++;
      counts.blobs += blobLookups(init).length;
      return answerGraphql(
        init,
        (sha) => [...docs.values()].find((doc) => doc.sha === sha)?.markdown ?? null,
      );
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
    counts.contents++;
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
    assert.equal(f.counts.graphql, 1);
    assert.equal(coldPages, 1);
    const coldGithub = f.counts.metadata + f.counts.tree + f.counts.graphql;
    const beforeBlobs = f.counts.blobs;
    let persistedPages = 0;
    const roundTrips = db.roundTrips;
    const nextStarted = performance.now();
    const second = await apiFor(f.fresh(), () => persistedPages++).search("検索");
    const persistedMs = performance.now() - nextStarted;
    assert.equal(second.items.length, 50);
    assert.equal(f.counts.blobs, beforeBlobs);
    assert.equal(persistedPages, 1);
    // Prune (first tree of a new adapter) plus one batched completeness check and search.
    assert.equal(db.roundTrips - roundTrips, 2);
    // Titles already in D1 need no GitHub reads, so the whole list is one page.
    const listed = await f.fresh().list(0);
    assert.equal(listed.items.length, 65);
    assert.equal(listed.next, null);
    assert.equal(f.counts.blobs, beforeBlobs);
    if (process.env.DESCARTES_BENCHMARK === "1")
      console.info(
        JSON.stringify({
          fixture: "65 synthetic documents, local SQLite (not production)",
          cold: {
            httpRequests: coldPages,
            githubRequests: coldGithub,
            githubBlobs: beforeBlobs,
            elapsedMs: coldMs,
          },
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

test("a restarted adapter opens a document from D1 without blob or Contents API reads", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db, 2);
    const first = await f.fresh().get(idOf(1));
    assert.equal(f.counts.blobs, 1);
    const roundTrips = db.roundTrips;
    assert.deepEqual(await f.fresh().get(idOf(1)), first);
    assert.equal(f.counts.blobs, 1);
    assert.equal(f.counts.contents, 0);
    assert.equal(f.counts.tree, 2);
    assert.equal(db.roundTrips - roundTrips, 2); // Prune on the new adapter's first tree, then the body read.
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

test("an unmigrated index makes search unavailable, and never reports a successful commit as a failed save", async () => {
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
    await assert.rejects(apiFor(store).search("committed"), { status: 503 });
    assert.equal(warning.mock.calls.length, 1); // Failure backoff avoids retry storms.
    assert.doesNotMatch(JSON.stringify(warning.mock.calls), /Successfully|fixture|needle/);
  } finally {
    warning.mockRestore();
    db.close();
  }
});

test("a D1 outage returns 503 without scanning GitHub and search recovers after the backoff", async () => {
  const db = new SqliteD1();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const f = fixture(db, 2);
    const store = f.fresh();
    assert.equal((await apiFor(store).search("needle")).items.length, 2);
    const { batch, prepare } = db;
    db.batch = db.prepare = () => {
      throw new Error("D1 unavailable");
    };
    const blobs = f.counts.blobs;
    for (let i = 0; i < 2; i++)
      await assert.rejects(apiFor(store).search("needle"), {
        status: 503,
        message: "検索インデックスを利用できません。",
      });
    assert.equal(f.counts.blobs, blobs);
    assert.equal(warning.mock.calls.length, 1); // The second request is rejected by the backoff.
    Object.assign(db, { batch, prepare });
    f.advance();
    assert.equal((await apiFor(store).search("needle")).items.length, 2);
  } finally {
    warning.mockRestore();
    db.close();
  }
});

test("cold indexed search hydrates one bounded page of GitHub reads per request", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db, 130);
    const store = f.fresh();
    let cursor: number | null = 0;
    let last;
    do {
      const github = () => f.counts.tree + f.counts.graphql + f.counts.metadata;
      const before = github();
      await store.privateOnly();
      const page = await store.search("needle", cursor);
      // Leaves room for Access JWKS and D1 writes within Workers Free's 50 subrequests.
      assert.ok(github() - before <= 18);
      last = page;
      cursor = page.next;
    } while (cursor !== null);
    // The final page has completed the index, so it returns the globally ranked, bounded result.
    assert.equal(last.items.length, 50);
    assert.equal(f.counts.blobs, 130);
  } finally {
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

test("a changed tree prunes versions that are no longer current, at most every ten minutes", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db, 2);
    const store = f.fresh();
    await apiFor(store).search("needle");
    const rows = () => db.sqlite.prepare("SELECT count(*) AS count FROM search_blobs").get()!.count;
    assert.equal(rows(), 2);
    f.external(idOf(0), "# Edited\nneedle");
    f.advance();
    await apiFor(store).search("needle");
    assert.equal(rows(), 3); // Within the interval the old version stays.
    for (let i = 0; i < 20; i++) f.advance();
    f.external(idOf(1), "# Edited too\nneedle");
    await apiFor(store).search("needle");
    assert.equal(rows(), 2);
    assert.deepEqual(
      (await apiFor(store).search("edited")).items.map((item) => item.title),
      ["Edited", "Edited too"],
    );
  } finally {
    db.close();
  }
});

test("cron warming indexes every document within the subrequest budget, then fetches no blobs", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db, 65);
    const github = () => f.counts.metadata + f.counts.tree + f.counts.blobs;
    const runs = [];
    for (let run = 0; run < 3; run++) {
      const before = github();
      const blobs = f.counts.blobs;
      // Each cron invocation is a cold adapter; Workers Free allows 50 external subrequests.
      runs.push({ ...(await f.fresh().warm()), blobs: f.counts.blobs - blobs });
      assert.ok(github() - before <= 50);
    }
    assert.deepEqual(runs[0], {
      documents: 65,
      indexed: 40,
      failed: 0,
      oversized: 0,
      remaining: 25,
      blobs: 40,
    });
    assert.deepEqual(runs[1], {
      documents: 65,
      indexed: 25,
      failed: 0,
      oversized: 0,
      remaining: 0,
      blobs: 25,
    });
    assert.deepEqual(runs[2], {
      documents: 65,
      indexed: 0,
      failed: 0,
      oversized: 0,
      remaining: 0,
      blobs: 0,
    });
    // A cold request after warming searches and lists from D1 without any blob reads.
    const blobs = f.counts.blobs;
    assert.equal((await apiFor(f.fresh()).search("needle")).items.length, 50);
    assert.equal((await f.fresh().list(0)).next, null);
    assert.equal(f.counts.blobs, blobs);
    // An external edit costs exactly one blob on the next run, and the old version is pruned.
    f.external(idOf(3), "# Edited\nfresh");
    assert.equal((await f.fresh().warm()).indexed, 1);
    assert.equal(f.counts.blobs, blobs + 1);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM search_blobs").get()!.count, 65);
    assert.equal((await apiFor(f.fresh()).search("fresh")).items[0].title, "Edited");
  } finally {
    db.close();
  }
});

test("an oversized document is skipped without stalling the warm batch it belongs to", async () => {
  const db = new SqliteD1();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const f = fixture(db, 20);
    // Exceeds the 2 MB row budget once the normalized search text is counted too.
    f.docs.set(idOf(1), { sha: shaOf(2), markdown: "# Huge secret\n" + "x".repeat(1_100_000) });
    const first = await f.fresh().warm(8);
    assert.deepEqual(first, { documents: 20, indexed: 7, failed: 0, oversized: 1, remaining: 12 });
    const indexed = () =>
      db.sqlite.prepare("SELECT count(*) AS count FROM search_blobs").get()!.count;
    assert.equal(indexed(), 7);
    // The next run makes progress past the batch that held the oversized document.
    const second = await f.fresh().warm(8);
    assert.deepEqual(second, { documents: 20, indexed: 7, failed: 0, oversized: 1, remaining: 5 });
    assert.equal(indexed(), 14);
    const third = await f.fresh().warm(8);
    assert.deepEqual(third, { documents: 20, indexed: 5, failed: 0, oversized: 1, remaining: 0 });
    assert.equal(indexed(), 19);
    // The index stayed available, and only counts were logged.
    assert.doesNotMatch(JSON.stringify(warning.mock.calls), /search_index_unavailable|Huge|secret/);
    assert.equal(warning.mock.calls.length, 3);
  } finally {
    warning.mockRestore();
    db.close();
  }
});

test("cold indexing of large documents keeps GitHub and D1 calls within the subrequest budget", async () => {
  const db = new SqliteD1();
  try {
    const f = fixture(db, 30);
    for (const [id, doc] of f.docs) doc.markdown += "\n" + "本文".repeat(30_000) + id;
    const store = f.fresh();
    let cursor: number | null = 0;
    let pages = 0;
    do {
      const github = () => f.counts.metadata + f.counts.tree + f.counts.graphql;
      const before = github() + db.roundTrips;
      const response = await route(
        new Request("https://app.test/api/search?q=needle&cursor=" + cursor),
        store,
      );
      // 50 minus Access JWKS, which the adapter never sees.
      assert.ok(github() + db.roundTrips - before <= 49);
      cursor = (await response.json()).next;
      pages++;
    } while (cursor !== null);
    assert.equal(pages, 3); // PAGE_BYTES ends a page after about 2 MiB of documents.
    assert.equal(f.counts.blobs, 30);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM search_blobs").get()!.count, 30);
  } finally {
    db.close();
  }
});

test("a GitHub read failure during indexing returns 502 without disabling the index", async () => {
  const db = new SqliteD1();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const f = fixture(db, 3);
    let fail = true;
    const store = github(f.env, async (input, init) => {
      if (fail && new URL(String(input)).pathname === "/graphql") {
        fail = false;
        return Response.json({ errors: [{ message: "upstream-secret" }] });
      }
      return f.send(input, init);
    });
    const response = await route(new Request("https://app.test/api/search?q=needle"), store);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /upstream-secret/);
    assert.equal(warning.mock.calls.length, 0);
    assert.equal((await apiFor(store).search("needle")).items.length, 3);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM search_blobs").get()!.count, 3);
  } finally {
    warning.mockRestore();
    db.close();
  }
});
