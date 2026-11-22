import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { MarkdownRenderer } from "../apps/web/src/renderer.ts";

class FakeWorker extends EventTarget {
  requests: { id: number; source: string }[] = [];
  terminated = false;
  postMessage(request: { id: number; source: string }) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  reply(index: number, result: { html?: string; error?: string }) {
    this.dispatchEvent(
      new MessageEvent("message", { data: { id: this.requests[index].id, ...result } }),
    );
  }
}

test("Markdown renders off-thread once per source and reuses the bounded cache", async () => {
  const worker = new FakeWorker();
  const renderer = new MarkdownRenderer(() => worker as unknown as Worker, 100);
  const first = renderer.render("one");
  const duplicate = renderer.render("one");
  assert.equal(worker.requests.length, 1);
  worker.reply(0, { html: "<p>one</p>" });
  assert.deepEqual(await Promise.all([first, duplicate]), ["<p>one</p>", "<p>one</p>"]);
  assert.equal(await renderer.render("one"), "<p>one</p>");
  assert.equal(worker.requests.length, 1);
  const large = renderer.render("large".repeat(20));
  worker.reply(1, { html: "large result".repeat(20) });
  await large;
  const again = renderer.render("large".repeat(20));
  assert.equal(worker.requests.length, 3); // Oversized output is not retained.
  worker.reply(2, { html: "ok" });
  await again;
});

test("out-of-order worker responses are associated with their source, and failures can retry", async () => {
  const workers: FakeWorker[] = [];
  const renderer = new MarkdownRenderer(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const first = renderer.render("first");
  const second = renderer.render("second");
  workers[0].reply(1, { html: "second html" });
  workers[0].reply(0, { html: "first html" });
  assert.equal(await first, "first html");
  assert.equal(await second, "second html");
  const fail = renderer.render("fails");
  const rejection = assert.rejects(fail, /worker failed/);
  workers[0].dispatchEvent(new Event("error"));
  await rejection;
  assert.equal(workers[0].terminated, true);
  const retry = renderer.render("fails");
  workers[1].reply(0, { html: "retried" });
  assert.equal(await retry, "retried");
});
