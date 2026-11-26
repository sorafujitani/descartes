import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  Notebook,
  notebookFor,
  type NotebookId,
  type NotebookNamespace,
  type WorkerEnv,
} from "../apps/api/src/notebook.ts";
import worker from "../apps/api/src/index.ts";
import { createApi } from "../apps/api/src/routes.ts";
import { answerGraphql, blobLookups } from "./support.ts";
import { SqliteD1 } from "./sqlite.ts";

const id = "00000000-0000-0000-0000-000000000001";
const image = "00000000-0000-0000-0000-000000000002.png";
const sha = "1".repeat(40);
const env: WorkerEnv = {
  GITHUB_REPOSITORY: "u/notebook",
  GITHUB_BRANCH: "main",
  GITHUB_TOKEN: "secret-token",
  ACCESS_AUD: "docs",
  ACCESS_ISSUER: "https://test.invalid",
};

// Stands in for the DO runtime: one object per name, like idFromName + get, and errors that
// cross RPC as plain Errors carrying only name, message and own fields.
const rpc = (object: Notebook) =>
  new Proxy(object, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          throw Object.assign(new Error((error as Error).message), { ...(error as object) });
        }
      };
    },
  });
function namespace(objectEnv: WorkerEnv) {
  const names: string[] = [];
  const objects = new Map<string, Notebook>();
  const fake: NotebookNamespace = {
    idFromName: (name) => {
      names.push(name);
      return name as unknown as NotebookId;
    },
    get: (key) => {
      const name = key as unknown as string;
      if (!objects.has(name)) objects.set(name, new Notebook({}, objectEnv));
      return rpc(objects.get(name)!);
    },
  };
  return { fake, names, objects };
}

/** GitHub stand-in on globalThis.fetch, which the object's adapter uses. */
function githubFetch() {
  const calls = { tree: 0, lookups: 0, graphql: 0, blob: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/u/notebook")) return Response.json({ private: true });
    if (path.includes("/git/trees/")) {
      calls.tree++;
      return Response.json({ tree: [{ path: `${id}.md`, type: "blob", sha }] });
    }
    if (path === "/graphql") {
      calls.graphql++;
      calls.lookups += blobLookups(init).length;
      return answerGraphql(init, (oid) => (oid === sha ? "# 共有\n本文" : null));
    }
    if (path.endsWith("/git/blobs/" + sha)) {
      calls.blob++;
      return Response.json({ content: Buffer.from("# 共有\n本文").toString("base64") });
    }
    if (path.endsWith("/contents/assets/" + image)) return new Response(null, { status: 404 });
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("requests share one Durable Object adapter per notebook scope", async () => {
  const github = githubFetch();
  const db = new SqliteD1();
  try {
    const { fake, names, objects } = namespace({ ...env, SEARCH_DB: db });
    const scoped = { ...env, NOTEBOOK: fake };
    const app = createApi<WorkerEnv>((_req, bindings) => notebookFor(bindings));
    const list = await app.fetch(new Request("https://app.test/api/docs"), scoped);
    const search = await app.fetch(new Request("https://app.test/api/search?q=本文"), scoped);
    assert.deepEqual(await list.json(), { items: [{ id, title: "共有" }], next: null });
    assert.deepEqual((await search.json()).items.length, 1);
    // The second request reused the first request's tree and indexed the blob only once.
    assert.deepEqual(github.calls, { tree: 1, lookups: 1, graphql: 1, blob: 0 });
    assert.equal(objects.size, 1);
    assert.equal(new Set(names).size, 1);
    assert.match(names[0], /^[0-9a-f]{64}$/);
    assert.ok(!names[0].includes("secret-token"));

    // HTTP statuses survive the RPC hop.
    const missing = await app.fetch(new Request("https://app.test/api/assets/" + image), scoped);
    assert.equal(missing.status, 404);

    // A rotated token addresses a fresh object.
    await notebookFor({ ...scoped, GITHUB_TOKEN: "rotated" });
    assert.equal(new Set(names).size, 2);
  } finally {
    github.restore();
    db.close();
  }
});

test("the cron warm runs in the notebook's Durable Object and shares its caches", async () => {
  const github = githubFetch();
  const db = new SqliteD1();
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const { fake, objects } = namespace({ ...env, SEARCH_DB: db });
    const scoped = { ...env, SEARCH_DB: db, NOTEBOOK: fake };
    await worker.scheduled({}, scoped);
    assert.equal(objects.size, 1);
    assert.deepEqual(github.calls, { tree: 1, lookups: 0, graphql: 0, blob: 1 });
    const report = JSON.parse(String(info.mock.calls[0][0]));
    assert.equal(report.status, "ok");
    assert.equal(report.indexed, 1);
    // The listing is served by the same object: no further tree or blob reads.
    const app = createApi<WorkerEnv>((_req, bindings) => notebookFor(bindings));
    const list = await app.fetch(new Request("https://app.test/api/docs"), scoped);
    assert.deepEqual(await list.json(), { items: [{ id, title: "共有" }], next: null });
    assert.deepEqual(github.calls, { tree: 1, lookups: 0, graphql: 0, blob: 1 });
    assert.equal(objects.size, 1);

    // Without the object binding (or the index) the cron run is skipped.
    await worker.scheduled({}, { ...env, SEARCH_DB: db });
    assert.equal(JSON.parse(String(info.mock.calls[1][0])).status, "skipped");
  } finally {
    info.mockRestore();
    github.restore();
    db.close();
  }
});

test("the Worker refuses to serve without the Durable Object binding", async () => {
  await assert.rejects(notebookFor(env), { status: 503 });
});
