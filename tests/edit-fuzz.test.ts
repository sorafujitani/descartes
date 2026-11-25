import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  breakBeforeHeading,
  closeFence,
  codeIndent,
  continueList,
  deleteMarker,
  deleteToMarker,
  indentItem,
  joinNextItem,
  moveLines,
  pasteLink,
  softBreak,
  todoShortcut,
  toggleTask,
  wrapOnType,
  wrapSelection,
} from "../packages/shared/src/edit.ts";

/** Deterministic pseudo-random numbers, so failures are reproducible from the seed. */
function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}
const lines = [
  "# タイトル",
  "## 見出し 😀",
  "- 箇条書き",
  "  - ネスト",
  "* star",
  "- [ ] 牛乳",
  "- [x] 卵",
  "1. 一",
  "2. 二",
  "  1. 入れ子",
  "> 引用",
  "> > 二重",
  "> - [ ] 引用の ToDo",
  "```js",
  "  const a = 1",
  "```",
  "~~~",
  "",
  "本文 **太字** と *斜体* と ~~取消~~ と `code`",
  "[リンク](https://example.com)",
  "---",
  "🌙👨‍👩‍👧‍👦 絵文字",
  "\t- タブ",
  "-",
  ">",
  "1.",
];
function documentFrom(next: () => number) {
  const count = 1 + Math.floor(next() * 12);
  return Array.from({ length: count }, () => lines[Math.floor(next() * lines.length)]).join("\n");
}
type Result = { text: string; start: number; end: number } | undefined;
function valid(name: string, source: string, result: Result) {
  if (!result) return;
  assert.ok(result.start >= 0 && result.start <= result.text.length, `${name} start`);
  assert.ok(result.end >= result.start && result.end <= result.text.length, `${name} end`);
}
/** Lines more than one away from the caret's line are untouched (single-line commands). */
function local(name: string, source: string, caret: number, result: Result) {
  if (!result) return;
  const before = source.split("\n");
  const after = result.text.split("\n");
  const line = source.slice(0, caret).split("\n").length - 1;
  const prefix = before.slice(0, Math.max(0, line - 1));
  assert.deepEqual(after.slice(0, prefix.length), prefix, `${name} changed lines above`);
}

test("shared editing commands never throw and keep positions valid on random notes", () => {
  for (let seed = 1; seed <= 1500; seed++) {
    const next = random(seed);
    const text = documentFrom(next);
    const caret = Math.floor(next() * (text.length + 1));
    const other = Math.floor(next() * (text.length + 1));
    const span = { start: Math.min(caret, other), end: Math.max(caret, other) };
    const context = `seed ${seed}: ${JSON.stringify(text)} @${caret}`;
    try {
      for (const [name, command] of [
        ["continueList", continueList],
        ["closeFence", closeFence],
        ["codeIndent", codeIndent],
        ["breakBeforeHeading", breakBeforeHeading],
        ["deleteMarker", deleteMarker],
        ["deleteToMarker", deleteToMarker],
        ["joinNextItem", joinNextItem],
        ["softBreak", softBreak],
        ["indent", (t: string, c: number) => indentItem(t, c, false)],
        ["outdent", (t: string, c: number) => indentItem(t, c, true)],
      ] as const) {
        const result = command(text, caret);
        valid(name, text, result);
        if (name !== "indent" && name !== "outdent") local(name, text, caret, result);
      }
      valid("toggleTask", text, toggleTask(text, span.start, span.end));
      for (const typed of ["*", "_", "`", "~", "["])
        valid("wrapOnType", text, wrapOnType(text, span, typed));
      valid("pasteLink", text, pasteLink(text, span, "https://example.com/x"));
      const todo = todoShortcut(text, caret);
      if (todo) assert.ok(todo.from <= todo.to && todo.to <= text.length);
      for (const delimiter of ["**", "*", "~~", "`"]) {
        const once = wrapSelection(text, span, delimiter);
        valid("wrapSelection", text, once);
        // Pressing the shortcut again restores the text (when the selection was plain text).
        if (
          span.end > span.start &&
          !/[*~`]/.test(text.slice(Math.max(0, span.start - 3), span.end + 3))
        ) {
          const twice = wrapSelection(once.text, once, delimiter);
          assert.equal(twice.text, text, `${delimiter} toggles back`);
        }
      }
      for (const up of [true, false]) {
        const moved = moveLines(text, span, up);
        valid("moveLines", text, moved);
        // Moving back restores the note when no numbered list was renumbered. (A selection
        // ending on an empty last line is ambiguous: its column 0 is also the note's end.)
        if (moved && !/^\s*\d+[.)]/m.test(text) && !moved.text.endsWith("\n")) {
          const back = moveLines(moved.text, moved, !up);
          assert.equal(back?.text, text, "move back");
        }
      }
    } catch (error) {
      throw new Error(`${context}\n${(error as Error).stack}`);
    }
  }
});
