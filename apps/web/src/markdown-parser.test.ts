import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initSync } from "@ox-content/wasm";
import { renderMarkdown } from "./markdown-parser";

const require = createRequire(import.meta.url);
initSync({ module: readFileSync(require.resolve("@ox-content/wasm/ox_content_wasm_bg.wasm")) });
test("actual WASM rendering preserves GFM but never enables raw HTML or MDX", () => {
  const html = renderMarkdown(
    "# 日本語\n\n- [x] done\n\n```js\nconst x = 1\n```\n\n<script>alert(1)</script>\n\n<Component />",
  );
  assert.match(html, /<h1[^>]*>日本語<\/h1>/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /<pre/);
  assert.doesNotMatch(html, /<script>|<Component/);
});

test("rendered task checkboxes follow unordered items outside fences", () => {
  const html = renderMarkdown(
    [
      "- [ ] a",
      "  - [x] nested",
      "* [X] star",
      "+ [ ] plus",
      "1. [ ] ordered",
      "> - [ ] quote",
      "```",
      "- [ ] code",
      "```",
      "- [ ] same",
      "- [x] same",
    ].join("\n"),
  );
  const checks = (value: string) =>
    [...value.matchAll(/<input type="checkbox"( checked)?/g)].map((match) => Boolean(match[1]));
  assert.deepEqual(checks(html), [false, true, true, false, false, false, false, true]);
  assert.match(html, /<code>- \[ \] code/);
});
