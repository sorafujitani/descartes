import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { github, type Env } from "../apps/api/src/github.ts";
import { answerGraphql, blobLookups, route } from "./support.ts";
import { SqliteD1 } from "./sqlite.ts";

const env: Env = {
  GITHUB_REPOSITORY: "u/notebook",
  GITHUB_BRANCH: "notes/main",
  GITHUB_TOKEN: "test",
  ACCESS_AUD: "docs",
  ACCESS_ISSUER: "https://test.invalid",
};
const shaOf = (n: number) => n.toString(16).padStart(40, "0");
const idOf = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
type Doc = { sha: string; markdown: string; size?: number; graphql?: "binary" | "truncated" };
function fixture(
  count: number,
  docOf: (i: number) => Partial<Doc> = () => ({}),
  extra: Partial<Env> = {},
) {
  let clock = 0,
    revision = 0,
    active = 0,
    maxActive = 0;
  let failGraphql: (() => Response) | undefined;
  // `blob`: REST blob reads; `lookups`: blobs requested through GraphQL.
  const calls = {
    contents: 0,
    tree: 0,
    blob: 0,
    graphql: 0,
    lookups: 0,
    write: 0,
    metadata: 0,
    conditional: 0,
  };
  const docs = new Map<string, Doc>(
    Array.from({ length: count }, (_, i) => [
      idOf(i),
      { sha: shaOf(i + 1), markdown: `# Note ${i}\n本文 ${i} performance`, ...docOf(i) },
    ]),
  );
  const bySha = (sha: string) => [...docs.values()].find((doc) => doc.sha === sha);
  const githubRequests = () => calls.metadata + calls.tree + calls.blob + calls.graphql;
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "manual");
    if (url.pathname === "/graphql") {
      calls.graphql++;
      assert.equal(init?.method, "POST");
      if (failGraphql) {
        const response = failGraphql();
        failGraphql = undefined;
        return response;
      }
      calls.lookups += blobLookups(init).length;
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return answerGraphql(init, (sha) => {
        const doc = bySha(sha);
        if (!doc) return null;
        assert.ok((doc.size ?? 0) <= 256 * 1024, "oversized blobs must not be read via GraphQL");
        if (doc.graphql === "binary") return { text: null, isBinary: true, isTruncated: false };
        if (doc.graphql === "truncated")
          return { text: doc.markdown.slice(0, 3), isBinary: false, isTruncated: true };
        return doc.markdown;
      });
    }
    if (url.pathname.endsWith("/notebook")) {
      calls.metadata++;
      return Response.json({ private: true });
    }
    if (url.pathname.includes("/git/trees/")) {
      calls.tree++;
      const etag = `"${revision}"`;
      if (new Headers(init?.headers).get("If-None-Match") === etag) {
        calls.conditional++;
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return Response.json(
        {
          tree: [...docs].map(([id, doc]) => ({
            path: `${id}.md`,
            type: "blob",
            sha: doc.sha,
            size: doc.size,
          })),
        },
        { headers: { ETag: etag } },
      );
    }
    if (url.pathname.includes("/git/blobs/")) {
      calls.blob++;
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      const sha = url.pathname.split("/").at(-1);
      const doc = bySha(sha!)!;
      return Response.json({
        content: Buffer.from(doc.markdown).toString("base64"),
        encoding: "base64",
      });
    }
    const id = url.pathname.split("/").at(-1)!.slice(0, -3);
    if (init?.method === "PUT") {
      calls.write++;
      const data = JSON.parse(String(init.body));
      assert.equal(data.branch, "notes/main");
      if (data.sha !== docs.get(id)?.sha) return new Response(null, { status: 409 });
      const sha = shaOf(10_000 + ++revision);
      docs.set(id, { sha, markdown: Buffer.from(data.content, "base64").toString() });
      return Response.json({ content: { sha } });
    }
    calls.contents++;
    const doc = docs.get(id);
    if (!doc) return new Response(null, { status: 404 });
    return Response.json({
      ...doc,
      encoding: "base64",
      content: Buffer.from(doc.markdown).toString("base64"),
    });
  };
  return {
    store: github({ ...env, ...extra }, send, () => clock),
    calls,
    docs,
    send,
    githubRequests,
    maxActive: () => maxActive,
    advance: () => {
      clock += 15_001;
    },
    failNextGraphql: (response = () => new Response(null, { status: 503 })) => {
      failGraphql = response;
    },
    externalEdit: (id: string, markdown: string) => {
      docs.set(id, { sha: shaOf(20_000 + ++revision), markdown });
    },
  };
}

test("a cold list reads the whole notebook through a few batched GraphQL requests", async () => {
  const f = fixture(130);
  const first = await f.store.list(0);
  assert.equal(first.items.length, 130);
  assert.equal(first.next, null);
  assert.equal(first.items[129].title, "Note 129");
  assert.equal(f.calls.tree, 1);
  assert.equal(f.calls.graphql, 2); // 100 + 30 aliased lookups.
  assert.equal(f.calls.lookups, 130);
  assert.equal(f.calls.blob, 0);
  // Every title is now known, so the list costs no blob read.
  const warm = await f.store.list(0);
  assert.deepEqual(warm, first);
  assert.equal(f.calls.graphql, 2);
  f.advance();
  await f.store.list(0);
  assert.equal(f.calls.tree, 2);
  assert.equal(f.calls.conditional, 1);
  assert.equal(f.calls.graphql, 2);
});

test("very large notebooks are paged by document count with few subrequests per page", async () => {
  const f = fixture(1201);
  let cursor: number | null = 0;
  const sizes: number[] = [];
  do {
    const before = f.githubRequests();
    await f.store.privateOnly();
    const page = await f.store.list(cursor);
    sizes.push(page.items.length);
    assert.ok(f.githubRequests() - before <= 7);
    cursor = page.next;
  } while (cursor !== null);
  assert.deepEqual(sizes, [500, 500, 201]);
  assert.equal(f.calls.lookups, 1201);
  assert.equal(f.calls.graphql, 13);
});

test("concurrent cold lists coalesce tree and blob reads", async () => {
  const f = fixture(32);
  const pages = await Promise.all([f.store.list(0), f.store.list(0), f.store.list(0)]);
  assert.deepEqual(pages[0], pages[2]);
  assert.equal(f.calls.tree, 1);
  assert.equal(f.calls.graphql, 1);
  assert.equal(f.calls.lookups, 32);
});

test("save invalidates tree immediately and seeds the title cache", async () => {
  const f = fixture(1);
  const before = await f.store.get(idOf(0));
  await f.store.list(0);
  assert.equal(f.calls.tree, 1);
  assert.equal(f.calls.blob, 1);
  const saved = await f.store.save(before.id, "# Renamed\n新しい検索語", before.sha);
  assert.notEqual(saved.sha, before.sha);
  const after = await f.store.list(0);
  assert.deepEqual(after.items, [{ id: saved.id, title: "Renamed" }]);
  assert.equal(f.calls.tree, 2);
  assert.equal(f.calls.blob, 1);
  await assert.rejects(f.store.save(before.id, "# stale", before.sha), { status: 409 });
  assert.equal((await f.store.get(before.id)).markdown, saved.markdown);
});

test("opening a listed document reuses the tree SHA and cached body without the Contents API", async () => {
  const f = fixture(2);
  await f.store.list(0);
  const doc = await f.store.get(idOf(1));
  assert.deepEqual(doc, {
    id: idOf(1),
    markdown: "# Note 1\n本文 1 performance",
    title: "Note 1",
    sha: shaOf(2),
  });
  assert.equal(f.calls.contents, 0);
  assert.equal(f.calls.tree, 1);
  assert.equal(f.calls.blob, 0);
  assert.equal(f.calls.graphql, 1);
  await f.store.get(idOf(1));
  assert.equal(f.calls.contents + f.calls.tree + f.calls.blob + f.calls.graphql, 2);
});

test("an id missing from the snapshot falls back to the Contents API and keeps 404", async () => {
  const f = fixture(1);
  await f.store.list(0);
  f.externalEdit(idOf(7), "# Created elsewhere"); // e.g. another isolate, within the tree TTL
  assert.equal((await f.store.get(idOf(7))).title, "Created elsewhere");
  assert.equal(f.calls.contents, 1);
  await assert.rejects(f.store.get(idOf(8)), { status: 404 });
  assert.equal(f.calls.contents, 2);
  assert.equal(f.calls.tree, 1);
});

test("external edits become readable after the tree TTL and stale SHAs still conflict on save", async () => {
  const f = fixture(1);
  const before = await f.store.get(idOf(0));
  f.externalEdit(idOf(0), "# 外部編集");
  const stale = await f.store.get(idOf(0));
  assert.equal(stale.sha, before.sha); // Bounded 15s staleness.
  await assert.rejects(f.store.save(stale.id, "# overwrite", stale.sha), { status: 409 });
  assert.equal(f.docs.get(idOf(0))!.markdown, "# 外部編集");
  const current = await f.store.get(idOf(0)); // The failed write invalidated the snapshot.
  assert.equal(current.title, "外部編集");
  f.externalEdit(idOf(0), "# Second edit");
  assert.equal((await f.store.get(idOf(0))).title, "外部編集");
  f.advance();
  assert.equal((await f.store.get(idOf(0))).title, "Second edit");
  assert.equal(f.calls.contents, 0);
});

test("failed GraphQL reads can be retried and do not poison single-flight state", async () => {
  const f = fixture(1);
  f.failNextGraphql();
  await assert.rejects(f.store.list(0), { status: 502 });
  assert.equal((await f.store.list(0)).items.length, 1);
  assert.equal(f.calls.graphql, 2);
});

test("GraphQL errors fail the request with a generic 502 and never leak upstream messages", async () => {
  const failures = [
    () => Response.json({ errors: [{ message: "upstream-secret rate limit exceeded" }] }),
    () =>
      Response.json({ data: null, errors: [{ type: "NOT_FOUND", message: "upstream-secret" }] }),
    () => Response.json({ message: "upstream-secret secondary rate limit" }, { status: 403 }),
    () => Response.json({ data: { repository: null } }),
    () => new Response("upstream-secret <html>", { status: 200 }),
  ];
  for (const failure of failures) {
    const f = fixture(3);
    f.failNextGraphql(failure);
    const response = await route(new Request("https://app.test/api/docs"), f.store);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /upstream-secret/);
    assert.equal(f.calls.blob, 0); // No REST storm after a failed batch.
    assert.equal((await f.store.list(0)).items[2].title, "Note 2");
  }
});

test("binary, truncated and oversized blobs fall back to the REST blob endpoint", async () => {
  const big = "# Big\n" + "x".repeat(300 * 1024);
  const f = fixture(6, (i) =>
    i === 1
      ? { graphql: "binary" }
      : i === 2
        ? { graphql: "truncated" }
        : i === 3
          ? { markdown: big, size: big.length }
          : i === 4
            ? { markdown: "\uFEFF# BOM title\nbody" }
            : {},
  );
  const page = await f.store.list(0);
  assert.deepEqual(
    page.items.map((item) => item.title),
    ["Note 0", "Note 1", "Note 2", "Big", "BOM title", "Note 5"],
  );
  assert.equal(f.calls.graphql, 1);
  assert.equal(f.calls.lookups, 5); // The oversized blob is never requested through GraphQL.
  assert.equal(f.calls.blob, 3);
  // Known fallbacks go straight to REST after the tree changes.
  f.externalEdit(idOf(5), "# Changed");
  f.advance();
  await f.store.list(0);
  assert.equal(f.calls.blob, 3);
  assert.equal(f.calls.lookups, 6);
});

test("warm tree revalidation observes external changes by SHA", async () => {
  const f = fixture(1);
  await f.store.list(0);
  f.externalEdit(idOf(0), "# 外部編集\nchanged");
  assert.equal((await f.store.list(0)).items[0].title, "Note 0"); // Bounded 15s external-edit staleness.
  f.advance();
  assert.equal((await f.store.list(0)).items[0].title, "外部編集");
});

test("simultaneous pages read each SHA once with bounded concurrency", async () => {
  const f = fixture(130, (i) => (i % 3 ? {} : { graphql: "binary" }));
  await Promise.all([0, 32, 64, 96, 128].map((cursor) => f.store.list(cursor)));
  assert.equal(f.calls.lookups, 130);
  assert.equal(f.calls.blob, 44);
  assert.ok(f.maxActive() <= 6);
});

test("a tree request started before a save cannot repopulate the invalidated snapshot", async () => {
  let finishOld!: (response: Response) => void;
  const old = new Promise<Response>((resolve) => {
    finishOld = resolve;
  });
  let trees = 0;
  const store = github(env, async (input, init) => {
    if (init?.method === "PUT") return Response.json({ content: { sha: shaOf(2) } });
    if (String(input).endsWith("/graphql")) return answerGraphql(init, () => "# Old");
    if (String(input).includes("/git/trees/")) {
      if (++trees === 1) return old;
      return Response.json({ tree: [{ path: `${idOf(1)}.md`, sha: shaOf(2), type: "blob" }] });
    }
    return Response.json({ content: Buffer.from("# Old").toString("base64") });
  });
  const stale = store.list(0);
  await store.save(idOf(1), "# New");
  assert.equal((await store.list(0)).items[0].title, "New");
  finishOld(Response.json({ tree: [{ path: `${idOf(1)}.md`, sha: shaOf(1), type: "blob" }] }));
  await stale;
  assert.equal((await store.list(0)).items[0].title, "New");
  assert.equal(trees, 2);
});

test("full-text search without a D1 index is unavailable instead of scanning GitHub", async () => {
  const f = fixture(130);
  await assert.rejects(f.store.search("performance"), {
    status: 503,
    message: "検索インデックスを利用できません。",
  });
  assert.deepEqual((await f.store.search("  ")).items, []);
  assert.equal(f.calls.tree + f.calls.blob, 0);
});

test("cold indexed search stays within a per-request subrequest budget with many REST fallbacks", async () => {
  const db = new SqliteD1();
  try {
    // Every tenth blob needs a REST fallback, which ends pages at the budget instead of PAGE_DOCS.
    const f = fixture(
      1200,
      (i) => ({
        graphql: i % 10 === 5 ? "binary" : undefined,
        markdown: `# Note ${i}\nterm-${i} performance`,
      }),
      { SEARCH_DB: db },
    );
    let cursor: number | null = 0;
    let pages = 0;
    let last;
    do {
      const before = f.githubRequests() + db.roundTrips;
      await f.store.privateOnly();
      const page = await f.store.search("term-1195", cursor);
      // 50 minus Access JWKS, which the adapter never sees; D1 index writes share the budget.
      assert.ok(f.githubRequests() + db.roundTrips - before <= 49);
      assert.ok(page.next === null || page.next > (cursor ?? 0));
      last = page;
      cursor = page.next;
      pages++;
    } while (cursor !== null);
    // The final page completed the index, so it is the global result.
    assert.deepEqual(
      last.items.map((item) => item.title),
      ["Note 1195"],
    );
    // Each fallback also reserves a whole D1 write batch, so pages are smaller than without D1.
    assert.ok(pages <= 6);
    assert.equal(f.calls.blob, 120);
    assert.ok(f.maxActive() <= 6);
  } finally {
    db.close();
  }
});

test("repository privacy is cached briefly for reads, never on failure, and never for writes", async () => {
  let privateRepo: boolean | undefined = true,
    calls = 0,
    clock = 0;
  const store = github(
    env,
    async () => {
      calls++;
      if (privateRepo === undefined) return new Response(null, { status: 502 });
      return Response.json({ private: privateRepo });
    },
    () => clock,
  );
  await Promise.all([store.privateOnly(), store.privateOnly()]);
  assert.equal(calls, 1);
  clock = 59_999;
  await store.privateOnly();
  assert.equal(calls, 1);
  await store.privateOnly({ fresh: true });
  assert.equal(calls, 2);
  clock = 59_999 + 60_000;
  privateRepo = false;
  await assert.rejects(store.privateOnly(), { status: 403 });
  assert.equal(calls, 3);
  await assert.rejects(store.privateOnly(), { status: 403 });
  assert.equal(calls, 4);
  privateRepo = undefined;
  await assert.rejects(store.privateOnly());
  await assert.rejects(store.privateOnly());
  assert.equal(calls, 6);
  privateRepo = true;
  await store.privateOnly();
  assert.equal(calls, 7);
  privateRepo = false;
  await assert.rejects(store.privateOnly({ fresh: true }), { status: 403 });
  // A failed fresh check also drops the earlier confirmation.
  await assert.rejects(store.privateOnly(), { status: 403 });
  assert.equal(calls, 9);
});

test("branch writes are serialized and a failed write does not stop the queue", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const store = github(env, async (_input, init) => {
    assert.equal(init?.method, "PUT");
    const index = ++writes;
    if (index === 1) {
      await gate;
      return new Response(null, { status: 409 });
    }
    return Response.json({ content: { sha: shaOf(999) } });
  });
  const first = store.save(idOf(1), "# first", shaOf(1));
  const rejection = assert.rejects(first, { status: 409 });
  const second = store.save(idOf(2), "# second");
  await Promise.resolve();
  assert.equal(writes, 1);
  release();
  await rejection;
  assert.equal((await second).title, "second");
  assert.equal(writes, 2);
});

test("only the docs subtree is listed, so assets and other entries are never returned", async () => {
  const requested: string[] = [];
  const store = github(env, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") return answerGraphql(init, () => "# Title");
    if (url.pathname.includes("/git/trees/")) {
      requested.push(url.pathname + url.search);
      return Response.json({
        tree: [
          { path: `${idOf(2)}.md`, sha: shaOf(2), type: "blob" },
          { path: "assets", sha: shaOf(3), type: "tree" },
          { path: `${idOf(4)}.png`, sha: shaOf(4), type: "blob" },
          { path: "readme.md", sha: shaOf(5), type: "blob" },
          { path: `${idOf(6)}.md`, sha: shaOf(6), type: "tree" },
          { path: `${idOf(1)}.md`, sha: shaOf(1), type: "blob" },
        ],
      });
    }
    return Response.json({ content: Buffer.from("# Title").toString("base64") });
  });
  const page = await store.list(0);
  assert.deepEqual(requested, ["/repos/u/notebook/git/trees/notes%2Fmain%3Adocs"]);
  assert.deepEqual(
    page.items.map((item) => item.id),
    [idOf(1), idOf(2)],
  );
});

test("a branch without docs/ is an empty notebook, but a missing branch still fails", async () => {
  const requested: string[] = [];
  const store = github(env, async (input) => {
    const path = new URL(String(input)).pathname;
    requested.push(path);
    if (path.endsWith("%3Adocs")) return new Response(null, { status: 404 });
    return Response.json({ tree: [{ path: "assets", sha: shaOf(1), type: "tree" }] });
  });
  assert.deepEqual(await store.list(0), { items: [], next: null });
  assert.deepEqual(requested, [
    "/repos/u/notebook/git/trees/notes%2Fmain%3Adocs",
    "/repos/u/notebook/git/trees/notes%2Fmain",
  ]);

  const missing = github(env, async () => new Response(null, { status: 404 }));
  await assert.rejects(missing.list(0), { status: 404 });
});
