import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  caretBelowTitle,
  linkAt,
  moveLines,
  pasteLink,
  wrapOnType,
  breakBeforeHeading,
  closeFence,
  continueList,
  deleteMarker,
  markerEnd,
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

test("Return closes a new fence, steps over the closing fence and leaves closed blocks alone", () => {
  assert.deepEqual(closeFence("# T\n```js", 9), { text: "# T\n```js\n\n```", start: 10, end: 10 });
  assert.deepEqual(closeFence("  ~~~\nrest", 5)?.text, "  ~~~\n\n  ~~~\nrest");
  assert.equal(closeFence("```\na\n```", 3), undefined, "already closed");
  assert.equal(closeFence("```js", 2), undefined, "not at the end of the line");
  assert.equal(closeFence("plain", 5), undefined);
  // Typing ``` right above the inserted closing fence steps over it.
  assert.deepEqual(closeFence("```\na\n```\n```", 9), {
    text: "```\na\n```\n",
    start: 10,
    end: 10,
  });
  assert.equal(closeFence("```\r\na\r\n```\r\n```", 11)?.text, "```\r\na\r\n```\r\n");
  assert.equal(closeFence("# T\r\n```", 8)?.text, "# T\r\n```\r\n\r\n```");
});

test("heading Return, marker Backspace and smart line start follow the Mac editor", () => {
  assert.deepEqual(breakBeforeHeading("# T\n## 節", 7), { text: "# T\n\n## 節", start: 8, end: 8 });
  assert.equal(breakBeforeHeading("# T", 2), undefined, "never above the title");
  assert.equal(breakBeforeHeading("# T\n## ", 7), undefined, "empty heading");
  assert.equal(breakBeforeHeading("```\n## x", 7), undefined, "inside code");
  assert.equal(breakBeforeHeading("# T\r\n## 節", 8)?.text, "# T\r\n\r\n## 節");
  assert.deepEqual(deleteMarker("# T\n  - [ ] a", 12), { text: "# T\n  a", start: 6, end: 6 });
  assert.equal(deleteMarker("# T\n- a", 6)?.text, "# T\na");
  assert.equal(deleteMarker("# T\n- a", 7), undefined, "not directly after the marker");
  assert.equal(deleteMarker("```\n- a", 6), undefined, "inside code");
  assert.equal(markerEnd("  * [x] done"), 8);
  assert.equal(markerEnd("1. item"), undefined);
});

test("typing a delimiter over a selection wraps it; a URL pasted over text makes a link", () => {
  const text = "# T\n日本語 text";
  const span = { start: 4, end: 7 };
  assert.deepEqual(wrapOnType(text, span, "*"), { text: "# T\n*日本語* text", start: 5, end: 8 });
  assert.equal(wrapOnType(text, span, "~")?.text, "# T\n~~日本語~~ text");
  assert.deepEqual(wrapOnType(text, span, "["), {
    text: "# T\n[日本語]() text",
    start: 10,
    end: 10,
  });
  assert.equal(wrapOnType(text, { start: 4, end: 4 }, "*"), undefined, "no selection");
  assert.equal(wrapOnType("a\nb", { start: 0, end: 3 }, "*"), undefined, "across lines");
  assert.equal(wrapOnType("```\ncode", { start: 4, end: 8 }, "*"), undefined, "inside code");
  assert.equal(wrapOnType(text, span, "x"), undefined);
  assert.deepEqual(pasteLink(text, span, " https://example.com/a?b=1 "), {
    text: "# T\n[日本語](https://example.com/a?b=1) text",
    start: 36,
    end: 36,
  });
  assert.equal(pasteLink(text, span, "not a url"), undefined);
  assert.equal(pasteLink(text, { start: 4, end: 4 }, "https://e.com"), undefined);
  assert.equal(pasteLink("https://a.com", { start: 0, end: 13 }, "https://e.com"), undefined);
  assert.equal(linkAt("see [site](https://e.com) and https://x.org/p", 7), "https://e.com");
  assert.equal(linkAt("see [site](https://e.com) and https://x.org/p", 35), "https://x.org/p");
  assert.equal(linkAt("plain text", 3), undefined);
});

test("lines move up and down with the selection; ordered lists renumber on Return", () => {
  assert.deepEqual(moveLines("a\nb\nc", { start: 3, end: 3 }, true), {
    text: "b\na\nc",
    start: 1,
    end: 1,
  });
  assert.deepEqual(moveLines("a\nb\nc", { start: 0, end: 3 }, false), {
    text: "c\na\nb",
    start: 2,
    end: 5,
  });
  assert.equal(moveLines("a\nb", { start: 0, end: 0 }, true), undefined);
  assert.equal(moveLines("a\nb", { start: 2, end: 2 }, false), undefined);
  const list = "1. a\n2. b\n   - nested\n3. c\n\n1. other";
  assert.equal(continueList(list, 4)?.text, "1. a\n2. \n3. b\n   - nested\n4. c\n\n1. other");
  assert.equal(continueList("1) a\n2. b", 4)?.text, "1) a\n2) \n2. b", "other delimiter");
});

test("an opened note's caret starts on the line below its title", () => {
  assert.equal(caretBelowTitle("# daily\n\ntask"), 8);
  assert.equal(caretBelowTitle("# 日本語\n本文"), 6);
  // A title-only note keeps the caret at the end of the title; a new note after "# ".
  assert.equal(caretBelowTitle("# daily"), 7);
  assert.equal(caretBelowTitle("# "), 2);
  assert.equal(caretBelowTitle("no title\nbody"), 0);
  assert.equal(caretBelowTitle(""), 0);
});
