import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  continueList,
  findMatch,
  headingCaret,
  indentItem,
  insertLink,
  toggleTask,
  toggleTaskAt,
  wrapSelection,
} from "../packages/shared/src/edit.ts";

test("return continues and exits lists, including inside a line, but not in fences", () => {
  for (const [line, expected] of [
    ["- メモ", "- "],
    ["  * entry", "  * "],
    ["9. 日本語", "10. "],
    ["  2) 😀", "  3) "],
    ["- [X] done", "- [ ] "],
    ["> quote", "> "],
  ] as const) {
    const next = continueList(line, line.length);
    assert.equal(next?.text, line + "\n" + expected);
    const exit = continueList(next!.text, next!.end);
    assert.equal(exit?.text, line + "\n");
  }
  assert.equal(continueList("- abc", 3)?.text, "- a\n- bc");
  for (const line of ["plain", "-word", "~~~~swift\n~~~\n- literal", "```\n- literal"]) {
    assert.equal(continueList(line, line.length), undefined);
  }
});

test("indent, task, heading, wrap and link keep the same markdown contract", () => {
  const indented = indentItem("- [ ] 日本語", 8, false);
  assert.equal(indented?.text, "  - [ ] 日本語");
  const checked = toggleTask(indented!.text, indented!.end);
  assert.equal(checked?.text, "  - [x] 日本語");
  assert.equal(indentItem(checked!.text, checked!.end, true)?.text, "- [x] 日本語");
  const doc = "# First\n~~~\n# not a heading\n~~~\n## Second";
  const next = headingCaret(doc, 0, true);
  assert.equal(next, doc.indexOf("Second"));
  assert.equal(headingCaret(doc, next!, false), 2);
  const bold = wrapSelection("🌙", { start: 0, end: 2 }, "**");
  assert.equal(bold.text, "**🌙**");
  const link = insertLink(bold.text, { start: 2, end: 4 });
  assert.equal(link.text, "**[🌙](https://)**");
  assert.equal(link.text.slice(link.start, link.end), "https://");
  assert.deepEqual(findMatch("AbC abc", "abc", 1, true), { start: 4, end: 7 });
  assert.deepEqual(findMatch("AbC abc", "abc", 0, false), { start: 4, end: 7 });
});

test("preview toggles the nth task, including duplicates, and skips fenced items", () => {
  const source = [
    "- [ ] a",
    "  - [x] nested",
    "1. [ ] ordered",
    "> - [ ] quote",
    "```",
    "- [ ] code",
    "```",
    "- [ ] same",
    "- [x] same",
  ].join("\n");
  assert.equal(toggleTaskAt(source, 0), source.replace("- [ ] a", "- [x] a"));
  assert.equal(toggleTaskAt(source, 1), source.replace("- [x] nested", "- [ ] nested"));
  assert.equal(toggleTaskAt(source, 4), source.replace("- [ ] same", "- [x] same"));
  assert.equal(toggleTaskAt(source, 5), source.replace("- [x] same", "- [ ] same"));
  assert.equal(toggleTaskAt(source, 6), undefined);
  assert.match(toggleTaskAt(source, 4)!, /```\n- \[ \] code\n```/);
});
