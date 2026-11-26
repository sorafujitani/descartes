import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import worker from "../apps/api/src/index.ts";
import { answerGraphql, route } from "./support.ts";
import { github, type Env } from "../apps/api/src/github.ts";
import { memoryStore } from "../apps/api/dev/demo.ts";
import { fail } from "../apps/api/src/repository.ts";
const env: Env = {
  GITHUB_REPOSITORY: "u/repo",
  GITHUB_BRANCH: "main",
  GITHUB_TOKEN: "fixture",
  ACCESS_AUD: "docs",
  ACCESS_ISSUER: "https://test.invalid",
};
const req = (path: string, method = "GET", body?: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://app.test/api/" + path, {
    method,
    body,
    headers: { "X-Descartes-Write": "1", ...headers },
  });
test("create, title list, read, rename without changing ID, and reject stale edit", async () => {
  const store = memoryStore();
  const create = await route(
    req("docs", "POST", JSON.stringify({ markdown: "# 朝\n本文" })),
    store,
  );
  assert.equal(create.status, 201);
  const doc = await create.json();
  assert.deepEqual(await (await route(req("docs"), store)).json(), {
    items: [{ id: doc.id, title: "朝" }],
    next: null,
  });
  assert.deepEqual(await (await route(req("docs/" + doc.id), store)).json(), doc);
  const update = () =>
    route(req("docs/" + doc.id, "PUT", JSON.stringify({ markdown: "# 夜", sha: doc.sha })), store);
  const saved = await (await update()).json();
  assert.notEqual(saved.sha, doc.sha);
  assert.equal(saved.id, doc.id);
  assert.equal((await update()).status, 409);
  assert.equal((await store.get(doc.id)).markdown, "# 夜");
});
test("private screenshot round trip and input boundaries", async () => {
  const store = memoryStore(),
    png = new Uint8Array(
      await readFile(new URL("../apps/web/public/icon-192.png", import.meta.url)),
    );
  const uploaded = await (await route(req("assets", "POST", png), store)).json();
  const image = await route(req(uploaded.path.slice(3)), store);
  assert.equal(image.headers.get("Content-Type"), "image/png");
  assert.equal(image.headers.get("Cache-Control"), "private, max-age=31536000, immutable");
  assert.equal(image.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(image.headers.get("Content-Security-Policy"), "default-src 'none'");
  const missing = await route(req("assets/" + crypto.randomUUID() + ".png"), store);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Cache-Control"), "private, no-store");
  const invalid = await route(req("assets/x.svg"), store);
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get("Cache-Control"), "private, no-store");
  const publicRepo = await route(req(uploaded.path.slice(3)), {
    ...store,
    privateOnly: async () => fail(403, "Repository is not private."),
  });
  assert.equal(publicRepo.status, 403);
  assert.equal(publicRepo.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  assert.equal((await route(req("assets", "POST", "<svg/>"), store)).status, 415);
  assert.equal(
    (await route(req("assets", "POST", new Uint8Array(4 * 1024 * 1024 + 1)), store)).status,
    413,
  );
  assert.equal((await route(req("docs", "POST", '{"markdown":"text"}'), store)).status, 400);
  assert.equal(
    (await route(req("docs", "POST", "{}", { Origin: "https://other.test" }), store)).status,
    403,
  );
});
test("GitHub adapter writes UTF-8 to the specified branch and forwards the read blob SHA", async () => {
  const id = crypto.randomUUID(),
    sha = "1".repeat(40),
    markdown = "# 文書\n";
  const store = github(env, async (url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture");
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/repo")) return Response.json({ private: true });
    if (path.includes("/git/trees/"))
      return Response.json({ tree: [{ path: id + ".md", sha, type: "blob" }] });
    if (path === "/graphql") {
      assert.equal(init?.method, "POST");
      return answerGraphql(init, (oid) => (oid === sha ? markdown : null));
    }
    assert.ok(path.endsWith("/contents/docs/" + id + ".md"));
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.branch, "main");
      assert.equal(body.sha, sha);
      assert.equal(Buffer.from(body.content, "base64").toString(), markdown);
      return new Response(null, { status: 409 });
    }
    return Response.json({
      encoding: "base64",
      sha,
      content: Buffer.from(markdown).toString("base64"),
    });
  });
  await store.privateOnly();
  assert.deepEqual(await store.list(0), { items: [{ id, title: "文書" }], next: null });
  assert.equal((await store.get(id)).markdown, markdown);
  await assert.rejects(store.save(id, markdown, sha), { status: 409 });
  await assert.rejects(github(env, async () => Response.json({ private: false })).privateOnly(), {
    status: 403,
  });
});
test("Access requires a valid signature, audience and expiration before repository access", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256" };
  const server = createServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const issuer = "http://127.0.0.1:" + addr.port;
    const scoped = { ...env, ACCESS_ISSUER: issuer, GITHUB_TOKEN: "" };
    const exp = Date.now() / 1000 + 60;
    function token(aud: string, end: number) {
      const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const body = enc({ kid: "test", alg: "RS256" }) + "." + enc({ iss: issuer, aud, exp: end });
      return body + "." + sign("sha256", Buffer.from(body), privateKey).toString("base64url");
    }
    const status = async (t: string) =>
      (await worker.fetch(req("docs", "GET", undefined, { "Cf-Access-Jwt-Assertion": t }), scoped))
        .status;
    for (const t of ["", token("other", exp), token("docs", 0), token("docs", exp) + "x"])
      assert.equal(await status(t), 401);
    assert.equal(await status(token("docs", exp)), 503);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
