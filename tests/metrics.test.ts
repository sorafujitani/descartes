import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { RequestMetrics, type RequestReport } from "../apps/api/src/metrics.ts";
import { createApi } from "../apps/api/src/routes.ts";
import { memoryStore } from "../apps/api/dev/demo.ts";

test("metrics measure failures too and expose bounded Server-Timing values", async () => {
  let clock = 10;
  const metrics = new RequestMetrics(() => clock);
  await metrics.measure("read", () => {
    clock += 5;
    return "ok";
  });
  await assert.rejects(
    metrics.measure("save", () => {
      clock += 3;
      throw new Error("private");
    }),
  );
  assert.equal(metrics.finish(), "read;dur=5.00, save;dur=3.00, total;dur=8.00");
});

test("request reports contain no user query, document IDs, bodies or credentials, including errors", async () => {
  const reports: RequestReport[] = [];
  const app = createApi(() => memoryStore(), { report: (report) => reports.push(report) });
  const query = "private-query-marker";
  for (const url of [
    "https://app.test/api/search?q=" + query,
    "https://app.test/api/docs/private-id-marker",
  ]) {
    const response = await app.fetch(new Request(url), {});
    assert.match(response.headers.get("Server-Timing")!, /total;dur=\d/);
    assert.match(response.headers.get("X-Request-ID")!, /^[a-f0-9-]{36}$/);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  assert.deepEqual(
    reports.map((report) => report.status),
    [200, 404],
  );
  assert.doesNotMatch(JSON.stringify(reports), /private-query-marker|private-id-marker/);
  assert.deepEqual(
    reports.map((report) => report.operation),
    ["search", "read"],
  );
});

test("telemetry failures cannot turn a successful write into an error", async () => {
  const app = createApi(() => memoryStore(), {
    report() {
      throw new Error("logger failure");
    },
  });
  const response = await app.fetch(
    new Request("https://app.test/api/docs", {
      method: "POST",
      headers: { "X-Descartes-Write": "1" },
      body: JSON.stringify({ markdown: "# Saved" }),
    }),
    {},
  );
  assert.equal(response.status, 201);
  assert.match(response.headers.get("Server-Timing")!, /save;dur=/);
});
