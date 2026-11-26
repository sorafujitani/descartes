import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mapConcurrent, semaphore } from "../apps/api/src/concurrency.ts";
import { Lru } from "../apps/api/src/lru.ts";
import { SingleFlight } from "../apps/api/src/single-flight.ts";

test("Lru evicts by count and weight; get keeps order, touch refreshes it", () => {
  const byCount = new Lru<string, number>(2);
  byCount.set("a", 1);
  byCount.set("b", 2);
  byCount.get("a");
  byCount.set("c", 3);
  assert.equal(byCount.has("a"), false);
  byCount.touch("b");
  byCount.set("d", 4);
  assert.deepEqual([byCount.has("b"), byCount.has("c"), byCount.has("d")], [true, false, true]);

  const byWeight = new Lru<string, string>(10, 6, (value) => value.length);
  byWeight.set("x", "aaa");
  byWeight.set("y", "bbb");
  byWeight.set("z", "cc");
  assert.deepEqual([byWeight.has("x"), byWeight.has("y"), byWeight.has("z")], [false, true, true]);
  byWeight.set("huge", "too long");
  assert.equal(byWeight.has("huge"), false);
  assert.equal(byWeight.has("y"), true);
  byWeight.set("y", "b");
  byWeight.set("w", "dddd");
  assert.deepEqual([byWeight.has("y"), byWeight.has("z"), byWeight.has("w")], [true, false, true]);
  byWeight.clear();
  byWeight.set("v", "eeeeee");
  assert.equal(byWeight.get("v"), "eeeeee");
});

test("SingleFlight shares a run per key and tag and clears it after failure", async () => {
  const flights = new SingleFlight<string, number, number>();
  let runs = 0;
  let release!: (value: number) => void;
  const task = () => {
    runs++;
    return new Promise<number>((resolve) => (release = resolve));
  };
  const first = flights.run("k", 1, task);
  const joined = flights.run("k", 1, task);
  const stale = release;
  const replaced = flights.run("k", 2, task);
  assert.ok(flights.peek("k")); // The latest flight, whatever its tag.
  assert.equal(runs, 2);
  stale(1);
  release(2);
  assert.deepEqual(await Promise.all([first, joined, replaced]), [1, 1, 2]);
  assert.equal(flights.peek("k"), undefined);
  await assert.rejects(
    flights.run("k", 1, () => Promise.reject(new Error("boom"))),
    /boom/,
  );
  assert.equal(await flights.run("k", 1, async () => 3), 3);
});

test("semaphore caps active tasks and mapConcurrent keeps order", async () => {
  const slot = semaphore(2);
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent(5, [1, 2, 3, 4, 5, 6], (n) =>
    slot(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return n * 10;
    }),
  );
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 2);
  await assert.rejects(
    mapConcurrent(2, [1, 2, 3], async (n) => {
      if (n === 1) throw new Error("first");
      return n;
    }),
    /first/,
  );
});
