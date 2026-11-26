import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { matchDocument, rankResults, searchTerms, client } from "../packages/shared/src/index.ts";
import { memoryStore } from "../apps/api/dev/demo.ts";
import { route } from "./support.ts";

test("Unicode-normalized multi-term search matches titles and body and ranks titles first", () => {
  const terms = searchTerms(" ＡＰＩ　保存 ");
  assert.deepEqual(terms, ["api", "保存"]);
  const body = matchDocument("1", "ノート", "# ノート\nAPIの保存を改善", terms)!;
  const title = matchDocument("2", "API 保存", "# API 保存\n実装", terms)!;
  assert.equal(body.snippet, "APIの保存を改善");
  assert.equal(matchDocument("3", "API", "# API\n描画", terms), undefined);
  assert.equal(rankResults([body, title])[0].id, "2");
  assert.equal(matchDocument("1", "Note", "# Note", []), undefined);
});

test("search endpoint uses the same matcher in demo, supports rename, and rejects oversized queries", async () => {
  const store = memoryStore();
  const doc = await store.save(crypto.randomUUID(), "# 日本語\nFull-text needle");
  const api = client("https://app.test", {}, async (input, init) =>
    route(new Request(String(input), init), store),
  );
  assert.equal((await api.search("NEEDLE 日本語")).items[0].id, doc.id);
  await api.save("# Renamed\n別の内容", doc);
  assert.equal((await api.search("needle")).items.length, 0);
  assert.equal((await api.search("renamed")).items[0].title, "Renamed");
  await assert.rejects(api.search("x".repeat(201)), { status: 400 });
  assert.equal((await api.search("  ")).items.length, 0);
});

test("search follows empty intermediate scan pages and progressively ranks a globally bounded result set", async () => {
  const store = memoryStore();
  for (let i = 0; i < 64; i++) await store.save(crypto.randomUUID(), `# Other ${i}\nbody`);
  const wanted = await store.save(crypto.randomUUID(), "# Needle\nlast page");
  const api = client("https://app.test", {}, async (input, init) =>
    route(new Request(String(input), init), store),
  );
  const counts: number[] = [];
  const result = await api.search("needle", undefined, (items) => counts.push(items.length));
  assert.deepEqual(counts, [0, 0, 1]);
  assert.equal(result.items[0].id, wanted.id);
  for (let i = 0; i < 64; i++) await store.save(crypto.randomUUID(), `# Match ${i}\nbody`);
  assert.equal((await api.search("body")).items.length, 50);
});

test("cancelling search between pages prevents further scans", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = client("https://app.test", {}, async () => {
    calls++;
    return Response.json({ items: [], next: 32 });
  });
  await assert.rejects(
    api.search("needle", controller.signal, () => controller.abort()),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("client streams pages before the full index is ready and forwards cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const api = client("https://app.test", { "X-Test": "yes" }, async (_input, init) => {
    calls++;
    assert.equal(init?.signal, controller.signal);
    assert.equal(new Headers(init?.headers).get("X-Test"), "yes");
    return Response.json({ items: [{ id: "1", title: "first" }], next: 1 });
  });
  const pages = api.pages(controller.signal);
  assert.equal((await pages.next()).value?.[0].title, "first");
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(pages.next(), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("client rejects a cyclic or invalid pagination cursor instead of looping forever", async () => {
  for (const next of [0, -1, 1.5, "8", undefined]) {
    const api = client("https://app.test", {}, async () => Response.json({ items: [], next }));
    await assert.rejects(api.list(), /Invalid document page/);
  }
});

test("client revalidates a complete title list with its ETag and stops on 304", async () => {
  const seenHeaders: (string | null)[] = [];
  const api = client("https://app.test", {}, async (_url, init) => {
    const match = new Headers(init?.headers).get("If-None-Match");
    seenHeaders.push(match);
    return match === '"v1"'
      ? new Response(null, { status: 304, headers: { ETag: '"v1"' } })
      : Response.json(
          { items: [{ id: "a", title: "A" }], next: null },
          { headers: { ETag: '"v1"' } },
        );
  });
  const seen: { etag?: string } = {};
  const first = [];
  for await (const page of api.pages(undefined, seen)) first.push(page);
  assert.deepEqual(first, [[{ id: "a", title: "A" }]]);
  assert.equal(seen.etag, '"v1"');
  const second = [];
  for await (const page of api.pages(undefined, seen)) second.push(page);
  assert.deepEqual(second, []);
  assert.equal(seen.etag, '"v1"');
  assert.deepEqual(seenHeaders, [null, '"v1"']);
});
