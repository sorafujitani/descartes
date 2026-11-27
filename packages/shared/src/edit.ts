export type Span = { start: number; end: number };
export const shortcutHelp = [
  ["⌘N", "新規ノート"],
  ["⌘S", "保存"],
  ["⌘P", "ノートを切り替える（最近使ったノートが先頭）"],
  ["⌘E", "インラインコード"],
  ["⌘F、⌘G / ⌘⇧G", "本文検索、次 / 前の一致"],
  ["⌘⌥[ / ⌘⌥]", "前 / 次の見出し"],
  ["Return", "リストを続ける。空の項目で字下げを戻す / 終了"],
  ["Return（```の後）", "コードブロックを閉じて中に入力"],
  ["Tab / ⇧Tab", "リストの字下げ / 戻す（それ以外ではタブを入力）"],
  ["⌘Return", "ToDoにする（選択した複数行も） / チェックを切り替える"],
  ["[] / 「」", "行頭で入力するとToDo（- [ ] ）になる"],
  ["⌘B / ⌘I / ⌘⇧X / ⌘⇧`", "太字 / 斜体 / 取り消し線 / インラインコード"],
  ["選択して * _ ` ~ [", "選択した文字を記号で囲む（[ はリンク）"],
  ["URLを選択文字に貼り付け", "リンク [文字](URL) にする"],
  ["⌥↑ / ⌥↓", "行を上 / 下へ移動（番号は振り直し）"],
  ["⇧Return", "リスト項目・引用の中で改行"],
  ["行末で Delete", "次の項目の本文をつなげる（記号は消す）"],
  ["⌘B などをもう一度", "書式を外す"],
  ["⌘クリック", "リンクを開く"],
  ["⌘L", "リンクを挿入"],
  ["⌘K", "ショートカット一覧"],
  ["⌘+ / ⌘− / ⌘0", "拡大 / 縮小 / 100%"],
  ["チェックボックスをタップ", "チェックを切り替える（保存されます）"],
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
/**
 * A list or quote line: quote prefix ("> ", "> > "), indentation, optional marker ("-", "1.")
 * and optional checkbox. `length` is where its text starts.
 */
const listPattern =
  /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+]|[0-9]{1,9}[.)])(?=[ \t]|$)(?:[ \t]+(\[[ xX]\])(?=[ \t]|$))?)?[ \t]*/;
type ListLine = {
  length: number;
  quote: string;
  indent: string;
  marker?: string;
  task: boolean;
  next: string;
};
function listLine(line: string): ListLine | undefined {
  const match = listPattern.exec(line)!;
  const [, quote, indent, marker, box] = match;
  if (!quote && !marker) return;
  const number = marker && /^(\d+)([.)])$/.exec(marker);
  const quoted = quote && !/[ \t]$/.test(quote) ? quote + " " : quote;
  return {
    length: match[0].length,
    quote,
    indent,
    marker,
    task: Boolean(box),
    next:
      quoted +
      (marker
        ? indent +
          (number ? String(Number(number[1]) + 1) + number[2] : marker) +
          (box ? " [ ] " : " ")
        : ""),
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
/**
 * Return at the end of an opening fence that nothing closes adds the closing fence and puts the
 * caret inside, so the rest of the note does not become code. Typing that closing fence by hand
 * right above the added one steps over it instead of doubling it. Mirrors
 * `NoteText.closeFence` in the Mac app.
 */
export function closeFence(text: string, caret: number) {
  const { start, stop, line: full } = lineAt(text, caret);
  const line = full.endsWith("\r") ? full.slice(0, -1) : full;
  if (caret !== start + line.length) return;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const fence = new Fence();
  for (const previous of text.slice(0, start).split("\n")) fence.consumes(previous);
  const inside = Boolean(fence.delimiter);
  if (!fence.consumes(line)) return;
  if (inside) {
    if (fence.delimiter || stop >= text.length) return;
    const next = lineAt(text, stop + 1);
    const nextLine = next.line.endsWith("\r") ? next.line.slice(0, -1) : next.line;
    if (nextLine.trim() !== line.trim()) return;
    return replace(text, caret, next.start + nextLine.length, newline, caret + newline.length);
  }
  const delimiter = fence.delimiter;
  // Is this fence the opener of a block that already exists below? Only if the text below, read
  // on its own, ends with a fence left open (this block's closer). Otherwise the text below is
  // self-contained, and pairing with the next block's opener would swallow the text in between.
  let closed = false;
  const alone = new Fence();
  if (stop < text.length)
    for (const rest of text.slice(stop + 1).split("\n")) {
      alone.consumes(rest);
      if (!closed) {
        fence.consumes(rest);
        if (!fence.delimiter) closed = true;
      }
    }
  if (closed && alone.delimiter) return;
  const indent = /^[ \t]*/.exec(line)![0];
  return replace(
    text,
    caret,
    caret,
    newline + newline + indent + delimiter,
    caret + newline.length,
  );
}
/**
 * Return at the start of a heading's text inserts an empty line above the heading instead of
 * splitting "## " from its text (as Return does at the start of an item). Not on the title line.
 * Mirrors `NoteText.breakBeforeHeading` in the Mac app.
 */
export function breakBeforeHeading(text: string, caret: number) {
  const { start, line } = lineAt(text, caret);
  const level = /^#{1,6} /.exec(line)?.[0].length;
  if (!level || start === 0 || caret !== start + level || !line.slice(level).replace(/\r$/, ""))
    return;
  if (fenced(text, start, line)) return;
  const newline = text.slice(start - 2, start) === "\r\n" ? "\r\n" : "\n";
  return replace(text, start, start, newline, caret + newline.length);
}
export function continueList(text: string, caret: number) {
  const { start, line } = lineAt(text, caret);
  const item = listLine(line);
  if (!item || fenced(text, start, line) || caret < start + item.length) return;
  if (item.length === line.length) {
    // An empty nested item moves out one level first; then it ends the list (in a quote, the
    // quote stays). An empty quote line leaves one quote level.
    if (item.marker && item.indent) return indentItem(text, caret, true);
    let keep = item.quote;
    if (!item.marker) {
      keep = item.quote.replace(/[ \t]*>[ \t]?$/, "");
      if (keep && !/[ \t]$/.test(keep)) keep += " ";
    }
    return replace(text, start, start + item.length, keep, start + keep.length);
  }
  const next = replace(text, caret, caret, "\n" + item.next, caret + 1 + item.next.length);
  return { ...next, text: renumberAfter(next.text, next.start) };
}
const orderedItem = /^([ \t]*)(\d{1,9})([.)])(?=[ \t]|$)/;
/**
 * Renumbers the ordered items that follow the item at `at` in the same list (same indentation
 * and delimiter; deeper lines are skipped), so inserting an item keeps 1, 2, 3… in order.
 */
export function renumberAfter(text: string, at: number) {
  const lines = text.split("\n");
  let index = text.slice(0, at).split("\n").length - 1;
  const first = orderedItem.exec(lines[index]);
  if (!first) return text;
  let number = Number(first[2]);
  for (index++; index < lines.length; index++) {
    const line = lines[index];
    const indent = /^[ \t]*/.exec(line)![0];
    if (indent.length > first[1].length && line.trim()) continue;
    const item = orderedItem.exec(line);
    if (!item || item[1] !== first[1] || item[3] !== first[3]) break;
    number++;
    lines[index] = item[1] + number + line.slice(item[1].length + item[2].length);
  }
  return lines.join("\n");
}
/**
 * Renumbers the whole ordered list containing line `index` (same indentation and delimiter;
 * deeper lines belong to its items) from its smallest number, e.g. after moving or indenting
 * an item. Nested lists whose first item was just created start at 1 (see indentItem).
 */
function renumberList(lines: string[], index: number) {
  const item = orderedItem.exec(lines[index] ?? "");
  if (!item) return;
  const belongs = (line: string) => {
    const other = orderedItem.exec(line);
    if (other)
      return other[1] === item[1] && other[3] === item[3]
        ? "item"
        : other[1].length > item[1].length
          ? "child"
          : undefined;
    const indent = /^[ \t]*/.exec(line)![0];
    return line.trim() && indent.length > item[1].length ? "child" : undefined;
  };
  let first = index;
  while (first > 0 && belongs(lines[first - 1])) first--;
  while (!orderedItem.exec(lines[first]) || orderedItem.exec(lines[first])![1] !== item[1]) first++;
  const members: number[] = [];
  for (let at = first; at < lines.length; at++) {
    const kind = belongs(lines[at]);
    if (!kind) break;
    if (kind === "item") members.push(at);
  }
  let number = Math.min(...members.map((at) => Number(orderedItem.exec(lines[at])![2])));
  for (const at of members) {
    const match = orderedItem.exec(lines[at])!;
    lines[at] = match[1] + number++ + lines[at].slice(match[1].length + match[2].length);
  }
}
/** Markers both editors replace with a dot, checkbox or quote bar (hidden, removed as one). */
const styledMarker = /^([ \t]*)((?:[-*+]|\d{1,9}[.)]) \[[ xX]\] |[-*+] |> )/;
/** Where the text of a bullet/task/quote line starts, for ⌘← / Home ("smart home"). */
export function markerEnd(line: string) {
  const match = styledMarker.exec(line);
  return match ? match[0].length : undefined;
}
/**
 * Backspace directly after a bullet, checkbox, quote or heading marker removes the whole
 * marker in one step. Indentation stays. Not inside fenced code.
 */
export function deleteMarker(text: string, caret: number) {
  const { start, line } = lineAt(text, caret);
  const match = styledMarker.exec(line) ?? /^()(#{1,6} )/.exec(line);
  if (!match || caret !== start + match[0].length || fenced(text, start, line)) return;
  return replace(text, start + match[1].length, caret, "", start + match[1].length);
}
/**
 * Delete at the end of a line joins the next bullet, task or quote line without its marker
 * ("- a" + "- b" → "- ab"), as Backspace at the start of its text does.
 */
export function joinNextItem(text: string, caret: number) {
  const { start, stop, line } = lineAt(text, caret);
  if (caret !== stop || stop >= text.length || fenced(text, start, line)) return;
  const next = lineAt(text, stop + 1);
  const marker = styledMarker.exec(next.line) ?? orderedItem.exec(next.line);
  if (!marker || fenced(text, next.start, next.line)) return;
  const textStart =
    next.start +
    marker[0].length +
    (/^[ \t]/.test(next.line.slice(marker[0].length)) && !styledMarker.exec(next.line) ? 1 : 0);
  return replace(text, caret, textStart, "", caret);
}
/** ⌘Backspace in a bullet/task/quote deletes back to its text, not the marker too. */
export function deleteToMarker(text: string, caret: number) {
  const { start, line } = lineAt(text, caret);
  const end = markerEnd(line);
  if (end === undefined || caret <= start + end || fenced(text, start, line)) return;
  return replace(text, start + end, caret, "", start + end);
}
/** Return inside a fenced code block keeps the current line's indentation. */
export function codeIndent(text: string, caret: number) {
  const { start, line } = lineAt(text, caret);
  if (!fenced(text, start, line) || /^[ \t]*(`{3,}|~{3,})/.test(line)) return;
  const indent = /^[ \t]*/.exec(line.slice(0, caret - start))![0];
  if (!indent) return;
  return replace(text, caret, caret, "\n" + indent, caret + 1 + indent.length);
}
/**
 * Shift-Return: a line break that stays in the current list item (indented to its text) or
 * quote, instead of starting a new item.
 */
export function softBreak(text: string, caret: number) {
  const { start, line } = lineAt(text, caret);
  const item = listLine(line);
  if (!item || fenced(text, start, line)) return;
  const quote = item.quote && !/[ \t]$/.test(item.quote) ? item.quote + " " : item.quote;
  const width = item.marker ? item.indent.length + item.marker.length + 1 : 0;
  const insert = "\n" + quote + " ".repeat(width);
  return replace(text, caret, caret, insert, caret + insert.length);
}
export function indentItem(text: string, caret: number, outdent: boolean) {
  const { start, line } = lineAt(text, caret);
  const item = listLine(line);
  if (!item?.marker || fenced(text, start, line)) return;
  const spaces = item.indent.endsWith("\t") ? 1 : Math.min(2, item.indent.length);
  const remove = outdent ? spaces : 0;
  if (outdent && remove === 0) return { text, start: caret, end: caret };
  const insert = outdent ? "" : "  ";
  const at = start + item.quote.length;
  const moved = replace(
    text,
    at,
    at + remove,
    insert,
    Math.max(at, caret + insert.length - remove),
  );
  if (!/^\d/.test(item.marker)) return moved;
  // Ordered items: the item's new list and the list it left are renumbered; a new nested list
  // starts at 1.
  const lines = moved.text.split("\n");
  const index = text.slice(0, start).split("\n").length - 1;
  const current = orderedItem.exec(lines[index])!;
  let previous = index - 1;
  while (
    previous >= 0 &&
    lines[previous].trim() &&
    /^[ \t]*/.exec(lines[previous])![0].length > current[1].length
  )
    previous--;
  const sibling = previous >= 0 && orderedItem.exec(lines[previous]);
  let shift = 0;
  if (!outdent && (!sibling || sibling[1] !== current[1])) {
    lines[index] = current[1] + "1" + lines[index].slice(current[1].length + current[2].length);
    shift = 1 - current[2].length;
  }
  renumberList(lines, index);
  if (index > 0) renumberList(lines, index - 1);
  for (let at = index + 1; at < lines.length; at++)
    if (orderedItem.exec(lines[at])) {
      renumberList(lines, at);
      break;
    }
  const result = lines.join("\n");
  const delta = result.length - moved.text.length;
  const caretAt = moved.start + (delta ? shift : 0);
  return { text: result, start: caretAt, end: caretAt };
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
 * "[]" (or "［］", or the Japanese IME's "「」") typed at the start of a line or bullet becomes "- [ ] ". `caret` is
 * just after the typed bracket. When nothing separates it from following text, the caller should
 * absorb one space typed next, so "- [] 牛乳" also gives "- [ ] 牛乳". Mirrors the Mac app.
 */
export function todoShortcut(text: string, caret: number) {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const before = text.slice(start, caret);
  const match = /^([ \t]*)(?:([-*+])[ \t]+)?(?:\[\]|［］|「」)$/.exec(before);
  if (!match || fenced(text, start, before)) return;
  const separated = text[caret] === " " || text[caret] === "\t";
  const insert = match[1] + (match[2] ?? "-") + (separated ? " [ ]" : " [ ] ");
  return { from: start, to: caret, insert, absorbSpace: !separated };
}
/**
 * Typing *, _, `, ~ or [ while text on one line is selected wraps it instead of replacing it
 * (~ makes ~~strikethrough~~, [ makes a link with the caret in its URL). Mirrors the Mac app.
 */
export function wrapOnType(text: string, span: Span, typed: string) {
  const pairs: Record<string, [string, string]> = {
    "*": ["*", "*"],
    _: ["_", "_"],
    "`": ["`", "`"],
    "~": ["~~", "~~"],
    "[": ["[", "]()"],
  };
  const pair = pairs[typed];
  const selected = text.slice(span.start, span.end);
  if (!pair || !selected || /[\r\n]/.test(selected)) return;
  const { start, line } = lineAt(text, span.start);
  if (fenced(text, start, line)) return;
  const [open, close] = pair;
  const result = text.slice(0, span.start) + open + selected + close + text.slice(span.end);
  if (typed === "[") {
    const caret = span.end + open.length + 2;
    return { text: result, start: caret, end: caret };
  }
  return { text: result, start: span.start + open.length, end: span.end + open.length };
}
/** Pasting a URL while text on one line is selected makes it a link: [text](url). */
export function pasteLink(text: string, span: Span, pasted: string) {
  const url = pasted.trim();
  const selected = text.slice(span.start, span.end);
  if (!selected || /[\r\n]/.test(selected) || !/^https?:\/\/[^\s<>()]+$/.test(url)) return;
  if (/^https?:\/\//.test(selected.trim())) return;
  const { start, line } = lineAt(text, span.start);
  if (fenced(text, start, line)) return;
  const link = "[" + selected + "](" + url + ")";
  const caret = span.start + link.length;
  return {
    text: text.slice(0, span.start) + link + text.slice(span.end),
    start: caret,
    end: caret,
  };
}
/**
 * Moves the lines covered by the selection up or down by one line (⌥↑ / ⌥↓), keeping the
 * selection on the moved text. Mirrors the Mac app.
 */
export function moveLines(text: string, span: Span, up: boolean) {
  const lines = text.split("\n");
  const first = text.slice(0, span.start).split("\n").length - 1;
  let endAt = span.end;
  if (span.end > span.start && text[span.end - 1] === "\n") endAt--;
  const last = text.slice(0, endAt).split("\n").length - 1;
  if (up ? first === 0 : last === lines.length - 1) return;
  const block = lines.slice(first, last + 1);
  const other = up ? lines[first - 1] : lines[last + 1];
  const shift = up ? -1 : 1;
  const result = up
    ? [...lines.slice(0, first - 1), ...block, other, ...lines.slice(last + 1)]
    : [...lines.slice(0, first), other, ...block, ...lines.slice(last + 2)];
  // Keep the selection on the same text by line and column, then renumber ordered lists the
  // moved lines belong to (their numbers can change width, e.g. 9 → 10).
  const position = (at: number) => {
    const before = text.slice(0, at).split("\n");
    return { line: before.length - 1 + shift, column: before.at(-1)!.length };
  };
  // A selection ending just after a line break ends with the moved block (its last line may
  // become the note's last line, without a break after it).
  const trailing = span.end > endAt;
  const anchors = [position(span.start), position(endAt)];
  const widths = result.map((line) => line.length);
  for (let at = first + shift; at <= last + shift; at++) renumberList(result, at);
  renumberList(result, up ? last : first);
  const offset = ({ line, column }: { line: number; column: number }) => {
    const grown = result[line].length - widths[line];
    const number = orderedItem.exec(result[line]);
    const moved = grown && number && column >= number[0].length ? grown : 0;
    let at = 0;
    for (let index = 0; index < line; index++) at += result[index].length + 1;
    return at + column + moved;
  };
  const joined = result.join("\n");
  const end = Math.min(joined.length, offset(anchors[1]) + (trailing ? 1 : 0));
  return { text: joined, start: Math.min(offset(anchors[0]), end), end };
}
/** The URL of a Markdown link or bare URL at `offset` in `line`, for ⌘-click. */
export function linkAt(line: string, offset: number) {
  for (const match of line.matchAll(
    /\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>()]+/g,
  )) {
    if (offset >= match.index && offset <= match.index + match[0].length)
      return match[1] ?? match[0];
  }
}
/** Whether a run of `run` delimiter characters contains `delimiter` (** in ***, * in ***). */
function formatted(run: number, delimiter: string) {
  if (delimiter === "**") return run === 2 || run === 3;
  if (delimiter === "*") return run === 1 || run === 3;
  return run >= delimiter.length;
}
/**
 * ⌘B / ⌘I / ⌘⇧X / inline code: wraps the selection, or removes the formatting when the
 * selection (or the text around it) already has it, so pressing the shortcut again undoes it.
 */
export function wrapSelection(
  text: string,
  span: Span,
  delimiter: string,
): Span & { text: string } {
  const mark = delimiter[0];
  const count = (from: number, step: number) => {
    let run = 0;
    while (text[from + step * run + (step < 0 ? -1 : 0)] === mark) run++;
    return run;
  };
  const d = delimiter.length;
  // Formatting just outside the selection: **[x]** → x.
  const outside = Math.min(count(span.start, -1), count(span.end, 1));
  if (span.end > span.start && formatted(outside, delimiter))
    return {
      text:
        text.slice(0, span.start - d) + text.slice(span.start, span.end) + text.slice(span.end + d),
      start: span.start - d,
      end: span.end - d,
    };
  // Formatting inside the selection: [**x**] → x.
  const selected = text.slice(span.start, span.end);
  let inside = 0;
  while (selected[inside] === mark && selected[selected.length - 1 - inside] === mark) inside++;
  if (selected.length > 2 * d && formatted(inside, delimiter))
    return {
      text: text.slice(0, span.start) + selected.slice(d, -d) + text.slice(span.end),
      start: span.start,
      end: span.end - 2 * d,
    };
  return {
    text: text.slice(0, span.start) + delimiter + selected + delimiter + text.slice(span.end),
    start: span.start + d,
    end: span.end + d,
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

/** Where an opened note's caret starts: the start of the line below its `#` title. */
export function caretBelowTitle(markdown: string) {
  if (!/^#\s/.test(markdown)) return 0;
  const end = markdown.indexOf("\n");
  return end === -1 ? markdown.length : end + 1;
}
