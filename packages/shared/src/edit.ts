export type Span = { start: number; end: number };
export const shortcutHelp = [
  ["⌘N", "新規ノート"],
  ["⌘S", "保存"],
  ["⌘P", "文書を検索"],
  ["⌘⇧P", "プレビュー切替"],
  ["⌘E", "編集に戻る / インラインコード"],
  ["⌘F、⌘G / ⌘⇧G", "本文検索、次 / 前の一致"],
  ["⌘⌥[ / ⌘⌥]", "前 / 次の見出し"],
  ["Return", "リストを続ける。空の項目で字下げを戻す / 終了"],
  ["Tab / ⇧Tab", "リストの字下げ / 戻す"],
  ["⌘Return", "ToDoにする（選択した複数行も） / チェックを切り替える"],
  ["[]", "行頭で入力するとToDo（- [ ] ）になる"],
  ["⌘B / ⌘I / ⌘⇧`", "太字 / 斜体 / インラインコード"],
  ["⌘L", "リンクを挿入"],
  ["⌘K", "ショートカット一覧"],
  ["⌘+ / ⌘− / ⌘0", "拡大 / 縮小 / 100%"],
  ["タップ", "プレビューのチェックを切り替える"],
] as const;

class Fence {
  delimiter = "";
  consumes(content: string) {
    const line = content.replace(/^[ \t]+/, "");
    if (this.delimiter) {
      const mark = this.delimiter[0];
      let count = 0;
      while (line[count] === mark) count++;
      if (count >= this.delimiter.length && /^\s*$/.test(line.slice(count))) this.delimiter = "";
      return true;
    }
    const first = line[0];
    if (first !== "`" && first !== "~") return false;
    let count = 0;
    while (line[count] === first) count++;
    if (count < 3) return false;
    this.delimiter = line.slice(0, count);
    return true;
  }
}
function lineAt(text: string, caret: number) {
  const start = text.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const end = text.indexOf("\n", caret);
  const stop = end < 0 ? text.length : end;
  return { start, stop, line: text.slice(start, stop) };
}
function fenced(text: string, start: number, line: string) {
  const fence = new Fence();
  for (const previous of text.slice(0, start).split("\n")) fence.consumes(previous);
  return fence.consumes(line);
}
const listPattern = /^([ \t]*)([-*+]|[0-9]{1,9}[.)]|>)(?:[ \t]+(\[[ xX]\])?)?[ \t]*/;
function listLine(line: string) {
  const match = listPattern.exec(line);
  if (!match) return;
  const markerEnd = match[1].length + match[2].length;
  if (markerEnd < line.length && line[markerEnd] !== " " && line[markerEnd] !== "\t") return;
  const marker = match[2];
  const number = /^(\d+)([.)])$/.exec(marker);
  return {
    length: match[0].length,
    indent: match[1],
    next:
      match[1] +
      (number ? String(Number(number[1]) + 1) + number[2] : marker) +
      (match[3] ? " [ ] " : " "),
  };
}
function replace(
  text: string,
  start: number,
  end: number,
  insert: string,
  caret: number,
): Span & { text: string } {
  return { text: text.slice(0, start) + insert + text.slice(end), start: caret, end: caret };
}
export function continueList(text: string, caret: number) {
  const { start, line } = lineAt(text, caret);
  const item = listLine(line);
  if (!item || fenced(text, start, line) || caret < start + item.length) return;
  // An empty nested item moves out one level first; at the top level it ends the list.
  if (item.length === line.length && item.indent) return indentItem(text, caret, true);
  if (item.length === line.length) return replace(text, start, start + item.length, "", start);
  return replace(text, caret, caret, "\n" + item.next, caret + 1 + item.next.length);
}
export function indentItem(text: string, caret: number, outdent: boolean) {
  const { start, line } = lineAt(text, caret);
  const item = listLine(line);
  if (!item || fenced(text, start, line)) return;
  const spaces = item.indent.endsWith("\t") ? 1 : Math.min(2, item.indent.length);
  const remove = outdent ? spaces : 0;
  if (outdent && remove === 0) return { text, start: caret, end: caret };
  const insert = outdent ? "" : "  ";
  return replace(
    text,
    start,
    start + remove,
    insert,
    Math.max(start, caret + insert.length - remove),
  );
}
const taskItem = /^(?:[ \t]*>[ \t]*)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\]/;
export type TaskLocation = { lineStart: number; lineEnd: number; box: number; line: string };
export function taskLocation(text: string, index: number): TaskLocation | undefined {
  const fence = new Fence();
  let seen = 0;
  let at = 0;
  for (const line of text.split("\n")) {
    const code = fence.consumes(line);
    const box = line.indexOf("[");
    const lineEnd = at + line.length;
    if (!code && box >= 0 && taskItem.test(line) && seen++ === index)
      return { lineStart: at, lineEnd, box, line };
    at = lineEnd + 1;
  }
}
function labelRange(task: TaskLocation) {
  const spaces = task.line.slice(task.box + 3).match(/^\s*/)?.[0].length ?? 0;
  return { start: task.lineStart + task.box + 3 + spaces, end: task.lineEnd };
}
export function toggleTaskAt(text: string, index: number) {
  const task = taskLocation(text, index);
  if (!task) return;
  const pos = task.lineStart + task.box + 1;
  return text.slice(0, pos) + (text[pos] === " " ? "x" : " ") + text.slice(pos + 1);
}
export function renameTask(text: string, index: number, label: string) {
  const task = taskLocation(text, index);
  if (!task) return;
  const range = labelRange(task);
  return text.slice(0, range.start) + label + text.slice(range.end);
}
export function removeTask(text: string, index: number) {
  const task = taskLocation(text, index);
  if (!task) return;
  if (text[task.lineEnd] === "\n")
    return text.slice(0, task.lineStart) + text.slice(task.lineEnd + 1);
  if (task.lineStart > 0) return text.slice(0, task.lineStart - 1) + text.slice(task.lineEnd);
  return text.slice(task.lineEnd);
}
export function insertTaskAfter(text: string, index: number, label = "") {
  const task = taskLocation(text, index);
  if (!task) return;
  const line = task.line.slice(0, task.box) + "[ ] " + label;
  return text.slice(0, task.lineEnd) + "\n" + line + text.slice(task.lineEnd);
}
export function spliceText(text: string, start: number, end: number, insert: string) {
  return text.slice(0, start) + insert + text.slice(end);
}
/** A line as ⌘Return sees it: quote/indent prefix, optional list marker and optional checkbox. */
const taskLinePattern =
  /^((?:[ \t]*>)*[ \t]*)(?:([-*+]|\d{1,9}[.)])(?=[ \t]|$))?([ \t]*)(\[[ xX]\])?/;
type TaskLine = { prefix: string; marker?: string; gap: string; box?: string; rest: string };
function taskLine(line: string): TaskLine | undefined {
  const match = taskLinePattern.exec(line)!;
  const [, prefix, marker, gap] = match;
  const box = marker && gap ? match[4] : undefined;
  const rest = line.slice((prefix + (marker ?? "") + gap + (box ?? "")).length);
  // Headings (including the title line) stay headings.
  const level = /^#*/.exec(rest)![0].length;
  if (!marker && level >= 1 && level <= 6 && (rest[level] ?? " ") === " ") return;
  return { prefix, marker, gap, box, rest };
}
const taskText = (task: TaskLine) =>
  task.prefix + (task.marker ?? "") + task.gap + (task.box ?? "") + task.rest;
/** Length up to the marker gap, or through the checkbox and one following space. */
const taskPrefix = (task: TaskLine) =>
  (task.prefix + (task.marker ?? "") + task.gap + (task.box ? "[ ]" : "")).length +
  (task.box && task.rest.startsWith(" ") ? 1 : 0);
/**
 * ⌘Return: turns the line at the caret (or every selected line) into a todo, or toggles its
 * checkbox when it already is one. Bullets and numbered items keep their marker; plain text gains
 * "- [ ] ". Headings and fenced code are left alone. Several todos are checked together unless all
 * of them already are. Mirrors `NoteText.toggleTask` in the Mac app.
 */
export function toggleTask(
  text: string,
  start: number,
  end = start,
): (Span & { text: string }) | undefined {
  let last = end;
  if (end > start && text[end - 1] === "\n") last--;
  const blockStart = text.lastIndexOf("\n", start - 1) + 1;
  const stop = text.indexOf("\n", last);
  const blockEnd = stop < 0 ? text.length : stop;
  const fence = new Fence();
  if (blockStart > 0)
    for (const line of text.slice(0, blockStart - 1).split("\n")) fence.consumes(line);
  const raw = text.slice(blockStart, blockEnd).split("\n");
  const lines = raw.map((full) => {
    const line = full.endsWith("\r") ? full.slice(0, -1) : full;
    const code = fence.consumes(line);
    const eligible = !code && (raw.length === 1 || /\S/.test(line));
    return { full, line, task: eligible ? taskLine(line) : undefined };
  });
  const targets = lines.flatMap((entry) => (entry.task ? [entry.task] : []));
  if (!targets.length) return;
  const toggling = targets.every((task) => task.box);
  const check = targets.some((task) => task.box === "[ ]");
  const moves: {
    line: number;
    oldPrefix: number;
    newPrefix: number;
    before: number;
    delta: number;
  }[] = [];
  let at = blockStart,
    output = "",
    shift = 0;
  for (const [index, { full, line, task }] of lines.entries()) {
    const ending = full.slice(line.length) + (index < lines.length - 1 ? "\n" : "");
    let updated: TaskLine | undefined;
    if (task && toggling && (task.box !== "[ ]") !== check)
      updated = { ...task, box: check ? "[x]" : "[ ]" };
    else if (task && !toggling && !task.box)
      updated = {
        ...task,
        marker: task.marker ?? "-",
        gap: " ",
        box: "[ ]",
        rest: /^[ \t]/.test(task.rest) ? task.rest : " " + task.rest,
      };
    const next = updated ? taskText(updated) : line;
    if (updated && task) {
      const delta = next.length - line.length;
      moves.push({
        line: at,
        oldPrefix: at + (toggling ? 0 : taskPrefix(task)),
        newPrefix: blockStart + output.length + (toggling ? 0 : taskPrefix(updated)),
        before: shift,
        delta,
      });
      shift += delta;
    }
    output += next + ending;
    at += full.length + 1;
  }
  if (!moves.length) return;
  const map = (location: number) => {
    let move: (typeof moves)[number] | undefined;
    for (const candidate of moves) if (candidate.line <= location) move = candidate;
    if (!move) return location;
    return location < move.oldPrefix ? move.newPrefix : location + move.before + move.delta;
  };
  const from = map(start);
  return {
    text: text.slice(0, blockStart) + output + text.slice(blockEnd),
    start: from,
    end: end === start ? from : Math.max(from, map(end)),
  };
}
/**
 * "[]" (or full-width "［］") typed at the start of a line or bullet becomes "- [ ] ". `caret` is
 * just after the typed bracket. When nothing separates it from following text, the caller should
 * absorb one space typed next, so "- [] 牛乳" also gives "- [ ] 牛乳". Mirrors the Mac app.
 */
export function todoShortcut(text: string, caret: number) {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const before = text.slice(start, caret);
  const match = /^([ \t]*)(?:([-*+])[ \t]+)?(?:\[\]|［］)$/.exec(before);
  if (!match || fenced(text, start, before)) return;
  const separated = text[caret] === " " || text[caret] === "\t";
  const insert = match[1] + (match[2] ?? "-") + (separated ? " [ ]" : " [ ] ");
  return { from: start, to: caret, insert, absorbSpace: !separated };
}
export function wrapSelection(
  text: string,
  span: Span,
  delimiter: string,
): Span & { text: string } {
  const selected = text.slice(span.start, span.end);
  return {
    text: text.slice(0, span.start) + delimiter + selected + delimiter + text.slice(span.end),
    start: span.start + delimiter.length,
    end: span.end + delimiter.length,
  };
}
export function insertLink(text: string, span: Span): Span & { text: string } {
  const label = span.start === span.end ? "リンク" : text.slice(span.start, span.end);
  const insert = "[" + label + "](https://)";
  const url = span.start + label.length + 3;
  return {
    text: text.slice(0, span.start) + insert + text.slice(span.end),
    start: url,
    end: url + 8,
  };
}
export function headingCaret(text: string, caret: number, forward: boolean) {
  const fence = new Fence();
  let at = 0;
  let found: number | undefined;
  const start = lineAt(text, caret).start;
  for (const line of text.split("\n")) {
    const level = line.match(/^#+/)?.[0].length ?? 0;
    if (!fence.consumes(line) && level >= 1 && level <= 6 && line[level] === " ") {
      if (forward && at > start) return at + level + 1;
      if (!forward && at < start) found = at + level + 1;
    }
    at += line.length + 1;
  }
  return found;
}
export function findMatch(
  text: string,
  query: string,
  from: number,
  forward: boolean,
): Span | null {
  if (!query) return null;
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const index = forward
    ? haystack.indexOf(needle, from)
    : from > 0
      ? haystack.lastIndexOf(needle, from - 1)
      : -1;
  const fallback = forward ? haystack.indexOf(needle) : haystack.lastIndexOf(needle);
  const wrapped = index >= 0 ? index : fallback;
  return wrapped < 0 ? null : { start: wrapped, end: wrapped + needle.length };
}
