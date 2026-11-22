import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import demo, { memoryStore } from "../apps/api/dev/demo.ts";
import { body } from "../apps/api/src/http.ts";
import { route } from "./support.ts";

const request = (path: string, init?: RequestInit) =>
  new Request("https://app.test/api/" + path, init);
test("Hono validates cursors, IDs, JSON and write origin, with private error responses", async () => {
  const store = memoryStore();
  const cases: [Request, number][] = [
    ...["-1", "1.5", "1e2", "Infinity", "9007199254740992", "%20"].map(
      (cursor): [Request, number] => [request("docs?cursor=" + cursor), 400],
    ),
    [request("docs/not-an-id"), 404],
    [request("docs", { method: "POST", body: '{"markdown":"# A"}' }), 403],
    [
      request("docs", { method: "POST", body: "invalid", headers: { "X-Descartes-Write": "1" } }),
      400,
    ],
    [
      request("docs", {
        method: "POST",
        body: '{"markdown":"# A"}',
        headers: { "X-Descartes-Write": "1", Origin: "https://evil.test" },
      }),
      403,
    ],
  ];
  for (const [req, status] of cases) {
    const response = await route(req, store);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(typeof (await response.json()).error, "string");
  }
  const hidden = await route(request("docs"), {
    ...store,
    async list() {
      throw new Error("private secret");
    },
  });
  assert.equal(hidden.status, 502);
  assert.deepEqual(await hidden.json(), { error: "Request failed." });
});

test("streamed body limits cancel the stream and release its reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = request("assets", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  await assert.rejects(body(req, 4), { status: 413 });
  assert.equal(cancelled, true);
  assert.equal(req.body?.locked, false);
  await assert.rejects(
    body(request("docs", { method: "POST", body: "12345", headers: { "Content-Length": "5" } }), 4),
    { status: 413 },
  );
});

test("the demo shares Hono routes but cannot serve a non-loopback hostname", async () => {
  const denied = await demo.fetch(new Request("https://public.test/api/docs"));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Cache-Control"), "private, no-store");
  const allowed = await demo.fetch(new Request("http://127.0.0.1:8788/api/docs"));
  assert.equal(allowed.status, 200);
});
