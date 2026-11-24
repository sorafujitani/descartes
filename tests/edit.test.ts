import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  continueList,
  findMatch,
  headingCaret,
  indentItem,
  insertLink,
  todoShortcut,
  toggleTask,
  toggleTaskAt,
  wrapSelection,
} from "../packages/shared/src/edit.ts";

test("return continues and exits lists, including inside a line, but not in fences", () => {
  for (const [line, expected] of [
    ["- メモ", "- "],
    ["9. 日本語", "10. "],
    ["- [X] done", "- [ ] "],
    ["> quote", "> "],
  ] as const) {
    const next = continueList(line, line.length);
    assert.equal(next?.text, line + "\n" + expected);
    const exit = continueList(next!.text, next!.end);
    assert.equal(exit?.text, line + "\n");
  }
  // An empty nested item first moves out a level, then ends the list (as on the Mac).
  for (const [line, expected, outdented] of [
    ["  * entry", "  * ", "* "],
    ["  2) 😀", "  3) ", "3) "],
    ["\t- [ ] a", "\t- [ ] ", "- [ ] "],
  ] as const) {
    const next = continueList(line, line.length);
    assert.equal(next?.text, line + "\n" + expected);
    const out = continueList(next!.text, next!.end);
    assert.equal(out?.text, line + "\n" + outdented);
    assert.equal(out?.end, out?.text.length);
    assert.equal(continueList(out!.text, out!.end)?.text, line + "\n");
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

test("⌘Return turns lines into todos the same way as the Mac app", () => {
  // [line, caret, result, caret after] — the same table as MarkdownCommandsTests.swift.
  for (const [line, caret, expected, after] of [
    ["", 0, "- [ ] ", 6],
    ["買い物", 3, "- [ ] 買い物", 9],
    ["買い物", 0, "- [ ] 買い物", 6],
    ["- 牛乳", 3, "- [ ] 牛乳", 7],
    ["- ", 2, "- [ ] ", 6],
    ["-", 1, "- [ ] ", 6],
    ["  * nested", 10, "  * [ ] nested", 14],
    ["3. 番号", 5, "3. [ ] 番号", 9],
    ["> 引用", 4, "> - [ ] 引用", 10],
    ["  字下げ", 5, "  - [ ] 字下げ", 11],
    ["- [ ] open", 4, "- [x] open", 4],
    ["* [X] done", 10, "* [ ] done", 10],
    ["> - [ ] 引用", 9, "> - [x] 引用", 9],
    ["#tag", 4, "- [ ] #tag", 10],
  ] as const) {
    const next = toggleTask("# Title\n" + line + "\n次の行", 8 + caret);
    assert.equal(next?.text, "# Title\n" + expected + "\n次の行", line);
    assert.deepEqual([next?.start, next?.end], [8 + after, 8 + after], line);
  }
  for (const [markdown, caret] of [
    ["# Title", 3],
    ["# Title\n## 見出し", 12],
    ["```\nコード", 6],
  ] as const)
    assert.equal(toggleTask(markdown, caret), undefined);
  // Multi-line: convert non-empty lines, then check/uncheck them together; CRLF is preserved.
  for (const newline of ["\n", "\r\n"]) {
    const doc = ["# T", "A", "", "- B", "- [x] C", "```", "D", "```", ""].join(newline);
    const start = doc.indexOf("A");
    const converted = toggleTask(doc, start, doc.indexOf("C") + 1 + newline.length);
    const expected = ["# T", "- [ ] A", "", "- [ ] B", "- [x] C", "```", "D", "```", ""];
    assert.equal(converted?.text, expected.join(newline));
    assert.equal(
      converted!.text.slice(converted!.start, converted!.end),
      ["A", "", "- [ ] B", "- [x] C", ""].join(newline),
    );
    const checked = toggleTask(converted!.text, converted!.start, converted!.end);
    assert.equal(checked?.text, converted!.text.replaceAll("[ ]", "[x]"));
    const unchecked = toggleTask(checked!.text, checked!.start, checked!.end);
    assert.equal(unchecked?.text, converted!.text.replaceAll("[x]", "[ ]"));
  }
});

test("typing [] at the start of a line or bullet creates a todo", () => {
  const type = (typed: string) => {
    let text = "# T\n";
    let absorb: number | undefined;
    for (const character of typed) {
      if (character === " " && absorb === text.length) {
        absorb = undefined;
        continue;
      }
      absorb = undefined;
      text += character;
      if (character !== "]" && character !== "］") continue;
      const todo = todoShortcut(text, text.length);
      if (!todo) continue;
      text = text.slice(0, todo.from) + todo.insert + text.slice(todo.to);
      if (todo.absorbSpace) absorb = text.length;
    }
    return text.slice(4);
  };
  // The same table as EditorInteractionTests.swift.
  for (const [typed, expected] of [
    ["- []", "- [ ] "],
    ["- [] 牛乳", "- [ ] 牛乳"],
    ["[]牛乳", "- [ ] 牛乳"],
    ["* []", "* [ ] "],
    ["  - [] 卵", "  - [ ] 卵"],
    ["［］ パン", "- [ ] パン"],
    ["- [ ] 明示", "- [ ] 明示"],
    ["a []", "a []"],
    ["- [x]", "- [x]"],
  ] as const)
    assert.equal(type(typed), expected, typed);
  assert.equal(todoShortcut("```\n- []", 9), undefined);
  // Typing [] before existing text keeps exactly one separating space.
  assert.deepEqual(todoShortcut("[] 牛乳", 2), {
    from: 0,
    to: 2,
    insert: "- [ ]",
    absorbSpace: false,
  });
});
