import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { assertFrontendMatchesBuild, frontendAssets } from "../scripts/deployment-assets.ts";

const built =
  '<script type="module" src="/assets/index-new.js"></script><link href="/assets/index-new.css" rel="stylesheet">';

test("release verification compares both client script and stylesheet, ignoring order/duplicates", () => {
  assert.deepEqual(
    assertFrontendMatchesBuild(
      built,
      '<link href="/assets/index-new.css"><link href="/manifest.webmanifest"><link href="/assets/index-new.js"><script src="/assets/index-new.js"></script>',
    ),
    ["/assets/index-new.css", "/assets/index-new.js"],
  );
});
test("a healthy old API cannot disguise an outdated UI or a missing stylesheet", () => {
  assert.throws(
    () => assertFrontendMatchesBuild(built, built.replace("index-new.js", "index-old.js")),
    /does not match/,
  );
  assert.throws(
    () => assertFrontendMatchesBuild(built, '<script src="/assets/index-new.js"></script>'),
    /does not match/,
  );
});
test("login responses and unsafe asset paths fail without echoing response content", () => {
  assert.throws(
    () => frontendAssets("<html>private login response</html>"),
    /No application assets/,
  );
  assert.throws(
    () => frontendAssets('<div data-src="/assets/index-new.js"></div>'),
    /No application assets/,
  );
  assert.throws(
    () => frontendAssets('<script src="/assets/../../private.js"></script>'),
    /Invalid frontend asset/,
  );
  assert.throws(
    () => frontendAssets('<script src="/assets/index.js?token=private"></script>'),
    /Invalid frontend asset/,
  );
});
