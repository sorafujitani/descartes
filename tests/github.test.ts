import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { github, type Env } from "../apps/api/src/github.ts";

const env: Env = {
  GITHUB_REPOSITORY: "u/notebook",
  GITHUB_BRANCH: "notes/main",
  GITHUB_TOKEN: "test",
  ACCESS_AUD: "docs",
  ACCESS_ISSUER: "https://test.invalid",
};
const shaOf = (n: number) => n.toString(16).padStart(40, "0");
const idOf = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
function fixture(count: number) {
  let clock = 0,
    revision = 0,
    active = 0,
    maxActive = 0;
  let failBlob = false;
  const calls = { tree: 0, blob: 0, write: 0, metadata: 0, conditional: 0 };
  const docs = new Map(
    Array.from({ length: count }, (_, i) => [
      idOf(i),
      { sha: shaOf(i + 1), markdown: `# Note ${i}\n本文 ${i} performance` },
    ]),
  );
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, "manual");
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
          })),
        },
        { headers: { ETag: etag } },
      );
    }
    if (url.pathname.includes("/git/blobs/")) {
      calls.blob++;
      if (failBlob) {
        failBlob = false;
        return new Response(null, { status: 503 });
      }
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      const sha = url.pathname.split("/").at(-1);
      const doc = [...docs.values()].find((doc) => doc.sha === sha)!;
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
    const doc = docs.get(id)!;
    return Response.json({
      ...doc,
      encoding: "base64",
      content: Buffer.from(doc.markdown).toString("base64"),
    });
  };
  return {
    store: github(env, send, () => clock),
    calls,
    docs,
    maxActive: () => maxActive,
    advance: () => {
      clock += 15_001;
    },
    failNextBlob: () => {
      failBlob = true;
    },
    externalEdit: (id: string, markdown: string) => {
      docs.set(id, { sha: shaOf(20_000 + ++revision), markdown });
    },
  };
}

test("32-item pages share one tree and immutable blobs, with bounded concurrency", async () => {
  const f = fixture(130);
  const first = await f.store.list(0);
  assert.equal(first.items.length, 32);
  assert.equal(first.next, 32);
  let page = first;
  let total = page.items.length;
  while (page.next !== null) {
    page = await f.store.list(page.next);
    total += page.items.length;
  }
  assert.equal(page.items.length, 2);
  assert.equal(total, 130);
  assert.equal(f.calls.tree, 1);
  assert.equal(f.calls.blob, 130);
  assert.ok(f.maxActive() <= 6);
  // Every title is now known, so the whole list is a single page without GitHub reads.
  const warm = await f.store.list(0);
  assert.equal(warm.items.length, 130);
  assert.equal(warm.next, null);
  assert.equal(f.calls.blob, 130);
  f.advance();
  await f.store.list(0);
  assert.equal(f.calls.tree, 2);
  assert.equal(f.calls.conditional, 1);
  assert.equal(f.calls.blob, 130);
});

test("concurrent cold lists coalesce tree and blob reads", async () => {
  const f = fixture(32);
  const pages = await Promise.all([f.store.list(0), f.store.list(0), f.store.list(0)]);
  assert.deepEqual(pages[0], pages[2]);
  assert.equal(f.calls.tree, 1);
  assert.equal(f.calls.blob, 32);
});

test("save invalidates tree immediately and seeds the title and full-text caches", async () => {
  const f = fixture(1);
  const before = await f.store.get(idOf(0));
  await f.store.list(0);
  assert.equal(f.calls.blob, 0);
  const saved = await f.store.save(before.id, "# Renamed\n新しい検索語", before.sha);
  assert.notEqual(saved.sha, before.sha);
  const after = await f.store.list(0);
  assert.deepEqual(after.items, [{ id: saved.id, title: "Renamed" }]);
  assert.equal(f.calls.tree, 2);
  assert.equal(f.calls.blob, 0);
  assert.equal((await f.store.search("新しい検索語")).items[0]?.id, before.id);
  assert.equal((await f.store.search("performance")).items.length, 0);
  await assert.rejects(f.store.save(before.id, "# stale", before.sha), { status: 409 });
  assert.equal((await f.store.get(before.id)).markdown, saved.markdown);
});

test("failed blob loads can be retried and do not poison single-flight state", async () => {
  const f = fixture(1);
  f.failNextBlob();
  await assert.rejects(f.store.list(0), { status: 502 });
  assert.equal((await f.store.list(0)).items.length, 1);
  assert.equal(f.calls.blob, 2);
});

test("warm tree revalidation observes external changes by SHA and invalidates search results", async () => {
  const f = fixture(1);
  await f.store.list(0);
  assert.equal((await f.store.search("performance")).items.length, 1);
  f.externalEdit(idOf(0), "# 外部編集\nchanged");
  assert.equal((await f.store.list(0)).items[0].title, "Note 0"); // Bounded 15s external-edit staleness.
  f.advance();
  assert.equal((await f.store.list(0)).items[0].title, "外部編集");
  assert.equal((await f.store.search("performance")).items.length, 0);
  assert.equal((await f.store.search("changed")).items[0].title, "外部編集");
});

test("blob concurrency is bounded across different simultaneous pages", async () => {
  const f = fixture(130);
  await Promise.all([0, 32, 64, 96, 128].map((cursor) => f.store.list(cursor)));
  assert.equal(f.calls.blob, 130);
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

test("cold full-text scans stay within a per-request subrequest budget even beyond 50 documents", async () => {
  const f = fixture(130);
  let cursor: number | null = 0;
  let inspectedMatches = 0;
  do {
    const before = f.calls.tree + f.calls.blob + f.calls.metadata;
    await f.store.privateOnly();
    const page = await f.store.search("performance", cursor);
    assert.ok(page.items.length <= 32);
    assert.ok(f.calls.tree + f.calls.blob + f.calls.metadata - before <= 34); // Leaves room for JWKS.
    inspectedMatches += page.items.length;
    cursor = page.next;
  } while (cursor !== null);
  assert.equal(inspectedMatches, 130);
  assert.ok(f.maxActive() <= 6);
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
  const store = github(env, async (input) => {
    const url = new URL(String(input));
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
  assert.deepEqual(await store.search("anything"), { items: [], next: null });
  assert.deepEqual(requested, [
    "/repos/u/notebook/git/trees/notes%2Fmain%3Adocs",
    "/repos/u/notebook/git/trees/notes%2Fmain",
  ]);

  const missing = github(env, async () => new Response(null, { status: 404 }));
  await assert.rejects(missing.list(0), { status: 404 });
});
