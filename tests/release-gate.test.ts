import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vite-plus/test";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .scripts as Record<string, string>;
const steps = ["check", "test", "build-storybook", "test:storybook", "test:production"];

function verifyReleasePath(name: "deploy" | "deploy:check", failStep = "") {
  // Validate the exact command grammar before executing anything. The test must NEVER
  // run an unknown script or a real Cloudflare binary, even after future package edits.
  assert.equal(scripts["gate:deploy"], steps.map((step) => `pnpm ${step}`).join(" && "));
  assert.equal(
    scripts[name],
    "pnpm gate:deploy && pnpm --filter @descartes/web exec cf deploy" +
      (name === "deploy:check" ? " --dry-run" : ""),
  );
  const expectedCache = resolve("node_modules/.cache");
  mkdirSync(expectedCache, { recursive: true });
  const cache = realpathSync(expectedCache);
  assert.equal(cache, expectedCache, "test artifacts stay inside this checkout");
  const directory = mkdtempSync(join(cache, "descartes-release-gate-"));
  try {
    const log = join(directory, "calls.log");
    writeFileSync(
      join(directory, "pnpm"),
      `#!/bin/sh
case "$1" in
  gate:deploy) exec /bin/sh -c "$GATE_SCRIPT" ;;
  check|test|build-storybook|test:storybook|test:production)
    printf '%s\\n' "$1" >> "$GATE_LOG"
    if [ "$1" = "$FAIL_STEP" ]; then exit 23; fi
    ;;
  --filter) printf 'publish\\n' >> "$GATE_LOG" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o700 },
    );
    const result = spawnSync("/bin/sh", ["-c", scripts[name]], {
      // No inherited credentials or real executables on PATH.
      env: {
        PATH: directory,
        GATE_SCRIPT: scripts["gate:deploy"],
        GATE_LOG: log,
        FAIL_STEP: failStep,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, calls: readFileSync(log, "utf8").trim().split("\n") };
  } finally {
    // Verify this exact owned temporary directory before recursive removal.
    assert.equal(dirname(realpathSync(directory)), cache);
    assert.match(basename(directory), /^descartes-release-gate-[\w-]+$/);
    rmSync(directory, { recursive: true });
  }
}

test("normal deployment and dry-run run every UI gate before reaching the mocked publisher", () => {
  for (const name of ["deploy", "deploy:check"] as const) {
    const result = verifyReleasePath(name);
    assert.equal(result.status, 0);
    assert.deepEqual(result.calls, [...steps, "publish"]);
  }
  // Spawns several real shells; allow for a busy machine instead of the 5s default.
}, 30_000);

test("failure of any gate, including browser interaction tests, prevents publication", () => {
  for (const name of ["deploy", "deploy:check"] as const)
    for (const [index, step] of steps.entries()) {
      const result = verifyReleasePath(name, step);
      assert.equal(result.status, 23);
      assert.deepEqual(result.calls, steps.slice(0, index + 1));
    }
}, 30_000);
