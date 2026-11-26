import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Facet, Transaction } from "@codemirror/state";
import {
  breakBeforeHeading,
  closeFence,
  codeIndent,
  continueList,
  deleteToMarker,
  joinNextItem,
  softBreak,
  deleteMarker,
  headingCaret,
  imagePath,
  insertLink,
  indentItem,
  linkAt,
  moveLines,
  pasteLink,
  wrapOnType,
  markerEnd,
  todoShortcut,
  toggleTask,
  wrapSelection,
  type Span,
} from "@descartes/shared";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  deleteCharForward,
  history,
  isolateHistory,
  historyKeymap,
  indentLess,
  insertNewline,
  insertTab,
  redo,
  undo,
} from "@codemirror/commands";
import { deleteMarkupBackward, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export type NoteViewHandle = {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  /** Runs an editing command (menus, the Mac app's bridge); false when it does not apply. */
  command(name: EditCommand): boolean;
};
/** Editing commands shared by keyboard shortcuts, the web toolbar and the Mac menus. */
export type EditCommand =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "link"
  | "task"
  | "heading-prev"
  | "heading-next"
  | "move-up"
  | "move-down"
  | "undo"
  | "redo";
/** Where repository images are loaded from (the Mac app serves them through its own scheme). */
export const assetSource = Facet.define<(name: string) => string, (name: string) => string>({
  combine: (values) => values[0] ?? ((name) => "/api/assets/" + name),
});
const externalChange = Annotation.define<boolean>();
const persistTask = Annotation.define<boolean>();

class TaskCheckbox extends WidgetType {
  constructor(
    readonly at: number,
    readonly checked: boolean,
    readonly disabled: boolean,
  ) {
    super();
  }
  eq(other: TaskCheckbox) {
    return (
      this.at === other.at && this.checked === other.checked && this.disabled === other.disabled
    );
  }
  updateDOM(dom: HTMLElement) {
    // Only ever reuse a checkbox; reusing another widget's element showed checkboxes on bullets.
    const input = dom.classList.contains("cm-task-box") ? dom.firstElementChild : null;
    if (!(input instanceof HTMLInputElement) || input.type !== "checkbox") return false;
    input.checked = this.checked;
    input.disabled = this.disabled;
    input.dataset.at = String(this.at);
    return true;
  }
  toDOM(view: EditorView) {
    // The box includes the gap before the text, so a caret on an empty todo stands where the
    // text will start (a margin on the input was not counted for the caret).
    const box = document.createElement("span");
    box.className = "cm-task-box";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task-checkbox";
    input.setAttribute("aria-label", "チェックを切り替える");
    box.append(input);
    this.updateDOM(box);
    input.addEventListener("change", () => {
      if (view.state.readOnly) return;
      const at = Number(input.dataset.at);
      if (!/^\[[ xX]\]$/.test(view.state.doc.sliceString(at - 1, at + 2))) return;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: input.checked ? "x" : " " },
        annotations: persistTask.of(true),
        userEvent: "input.task",
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Ordinary "-", "*" and "+" items show a dot, as in the Mac app; the Markdown is unchanged. */
class BulletMark extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof BulletMark;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-bullet";
    dot.setAttribute("aria-hidden", "true");
    return dot;
  }
}
const bullet = Decoration.replace({ atomic: true, widget: new BulletMark() });
class QuoteBar extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof QuoteBar;
  }
  toDOM() {
    const bar = document.createElement("span");
    bar.className = "cm-quote-bar";
    bar.setAttribute("aria-hidden", "true");
    return bar;
  }
}
const quoteBar = Decoration.replace({ atomic: true, widget: new QuoteBar() });
/**
 * Applies a shared edit command (packages/shared/src/edit.ts, mirrored by the Mac app) at the
 * caret. Return, Backspace and ⌘Return use the same rules as the Mac editor instead of
 * CodeMirror's own Markdown commands, so both clients behave identically.
 */
function sharedCommand(
  command: (text: string, caret: number) => (Span & { text: string }) | undefined,
) {
  return (view: EditorView) => {
    const { from, to } = view.state.selection.main;
    if (view.state.readOnly || from !== to || view.state.selection.ranges.length > 1) return false;
    const previous = view.state.doc.toString();
    const next = command(previous, from);
    if (!next) return false;
    view.dispatch({
      changes: minimalChange(previous, next.text),
      selection: { anchor: next.start },
      userEvent: "input",
      scrollIntoView: true,
    });
    return true;
  };
}
function applyEdit(
  view: EditorView,
  previous: string,
  next: Span & { text: string },
  userEvent: string,
) {
  view.dispatch({
    changes: minimalChange(previous, next.text),
    selection: { anchor: next.start, head: next.end },
    userEvent,
    scrollIntoView: true,
  });
}
/** ⌘Return: make the line(s) todos, or check/uncheck them (which saves like a checkbox click). */
function toggleTaskCommand(view: EditorView) {
  if (view.state.readOnly) return true;
  const previous = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  const next = toggleTask(previous, from, to);
  if (next) {
    const toggled = next.text.length === previous.length;
    view.dispatch({
      changes: minimalChange(previous, next.text),
      selection: { anchor: next.start, head: next.end },
      annotations: toggled ? persistTask.of(true) : [],
      userEvent: toggled ? "input.task" : "input",
      scrollIntoView: true,
    });
  }
  return true;
}
const delimiters = { bold: "**", italic: "*", strike: "~~", code: "`" } as const;
export function runCommand(view: EditorView, name: EditCommand): boolean {
  const previous = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  const span = { start: from, end: to };
  switch (name) {
    case "undo":
      return undo(view);
    case "redo":
      return redo(view);
    case "heading-prev":
    case "heading-next": {
      const at = headingCaret(previous, from, name === "heading-next");
      if (at === undefined) return false;
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      return true;
    }
  }
  if (view.state.readOnly) return false;
  switch (name) {
    case "task":
      return toggleTaskCommand(view);
    case "move-up":
    case "move-down":
      return moveSelectedLines(view, name === "move-up");
    case "link":
      applyEdit(view, previous, insertLink(previous, span), "input");
      return true;
    default:
      applyEdit(view, previous, wrapSelection(previous, span, delimiters[name]), "input");
      return true;
  }
}
/** ⌥↑ / ⌥↓ with the same rules as the Mac app. */
function moveSelectedLines(view: EditorView, up: boolean) {
  if (view.state.readOnly) return true;
  const previous = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  const moved = moveLines(previous, { start: from, end: to }, up);
  if (moved) applyEdit(view, previous, moved, "move.line");
  return true;
}
/** ⌘← / Home first stops after a bullet or checkbox, then reaches the line start (as on the Mac). */
function smartLineStart(view: EditorView) {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  const end = markerEnd(line.text);
  const target = view.moveToLineBoundary(range, false);
  if (end === undefined || target.head !== line.from || range.head <= line.from + end) return false;
  view.dispatch({ selection: { anchor: line.from + end }, scrollIntoView: true });
  return true;
}
/** Replace only the changed span, so undo history and other selections stay put. */
function minimalChange(previous: string, next: string) {
  let from = 0,
    end = previous.length,
    nextEnd = next.length;
  while (from < end && from < nextEnd && previous[from] === next[from]) from++;
  while (end > from && nextEnd > from && previous[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return { from, to: end, insert: next.slice(from, nextEnd) };
}

class RepositoryImage extends WidgetType {
  constructor(
    readonly name: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: RepositoryImage) {
    return this.name === other.name && this.alt === other.alt;
  }
  toDOM(view: EditorView) {
    const image = document.createElement("img");
    image.src = view.state.facet(assetSource)(this.name);
    image.alt = this.alt;
    image.className = "cm-note-image";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("load", () => view.requestMeasure());
    return image;
  }
  ignoreEvent() {
    return true;
  }
}
/** "タイトル" shown in an empty first line, so a new note asks for its title. */
class TitlePlaceholder extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof TitlePlaceholder;
  }
  toDOM() {
    const hint = document.createElement("span");
    hint.className = "cm-title-placeholder";
    hint.textContent = "タイトル";
    hint.setAttribute("aria-hidden", "true");
    return hint;
  }
}
const titlePlaceholder = Decoration.widget({ widget: new TitlePlaceholder(), side: 1 });
const hiddenMark = Decoration.replace({});
const inlineCode = Decoration.mark({ class: "cm-inline-code" });
const linkLabel = Decoration.mark({ class: "cm-link-label" });
const inlineMarks = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);
function taskDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  /** Whether the caret or a selection touches [from, to] (then its Markdown is shown). */
  const editing = (from: number, to: number) =>
    view.hasFocus &&
    view.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  const first = view.state.doc.line(1);
  if (/^#[ \t]*$/.test(first.text)) ranges.push(titlePlaceholder.range(first.to));
  for (const visible of view.visibleRanges)
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        // Live preview: inline Markdown (**, *, ~~, `, link syntax) is hidden unless the caret
        // is inside that element, like other note editors. The text itself never changes.
        if (
          node.name === "Emphasis" ||
          node.name === "StrongEmphasis" ||
          node.name === "Strikethrough" ||
          node.name === "InlineCode"
        ) {
          const marks: [number, number][] = [];
          for (let child = node.node.firstChild; child; child = child.nextSibling)
            if (inlineMarks.has(child.name)) marks.push([child.from, child.to]);
          if (node.name === "InlineCode" && marks.length === 2 && marks[0][1] < marks[1][0])
            ranges.push(inlineCode.range(marks[0][1], marks[1][0]));
          if (!editing(node.from, node.to))
            for (const [from, to] of marks) if (to > from) ranges.push(hiddenMark.range(from, to));
        } else if (node.name === "Link") {
          const marks: { name: string; from: number; to: number }[] = [];
          for (let child = node.node.firstChild; child; child = child.nextSibling)
            marks.push({ name: child.name, from: child.from, to: child.to });
          const open = marks.find((mark) => mark.name === "LinkMark");
          const close = marks.filter((mark) => mark.name === "LinkMark")[1];
          const url = marks.find((mark) => mark.name === "URL");
          // Only [label](url) links: the label stays, the brackets and URL hide.
          if (open && close && url && close.from > open.to) {
            ranges.push(linkLabel.range(open.to, close.from));
            if (!editing(node.from, node.to)) {
              ranges.push(hiddenMark.range(open.from, open.to));
              ranges.push(hiddenMark.range(close.from, node.to));
            }
          }
        }
        if (node.name === "Table") {
          // Tables keep their columns aligned in a monospaced font.
          for (
            let line = view.state.doc.lineAt(node.from);
            ;
            line = view.state.doc.line(line.number + 1)
          ) {
            ranges.push(Decoration.line({ class: "cm-table" }).range(line.from));
            if (line.to >= node.to || line.number >= view.state.doc.lines) break;
          }
        }
        if (node.name === "ListMark") {
          // Wrapped item text lines up after its dot, checkbox or number. Nesting is shown by
          // the list depth (a clear step per level), not by the width of the leading spaces.
          const line = view.state.doc.lineAt(node.from);
          let depth = -1;
          for (let parent = node.node.parent; parent; parent = parent.parent)
            if (parent.name === "BulletList" || parent.name === "OrderedList") depth++;
          const indent = Math.max(0, Math.min(maxDepth, depth));
          const leading = view.state.doc.sliceString(line.from, node.from);
          if (leading && /^[ \t]+$/.test(leading))
            ranges.push(Decoration.replace({ atomic: true }).range(line.from, node.from));
          const mark = view.state.doc.sliceString(node.from, node.to);
          const task = /^[ \t]+\[[ xX]\]/.test(view.state.doc.sliceString(node.to, node.to + 5));
          const digits = mark.length - 1;
          const kind =
            task || /^[-*+]$/.test(mark) ? "b" : digits >= 3 ? "o3" : digits === 2 ? "o2" : "b";
          ranges.push(Decoration.line({ class: `cm-hang-${kind}-${indent}` }).range(line.from));
          // Numbers (and their space) sit in a fixed-width box like bullets and checkboxes, so
          // the text and its wrapped lines start at the same place whatever the font.
          if (!task && /^\d/.test(mark) && view.state.doc.sliceString(node.to, node.to + 1) === " ")
            ranges.push(
              Decoration.mark({ class: `cm-ordered cm-ordered-${Math.min(3, digits)}` }).range(
                node.from,
                node.to + 1,
              ),
            );
        }
        if (node.name === "QuoteMark") {
          // The first "> " on a line becomes a quote bar (the Mac app hides it the same way).
          const line = view.state.doc.lineAt(node.from);
          const prefix = view.state.doc.sliceString(line.from, node.from);
          const space = view.state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
          // Every quote level ("> > ") becomes its own bar.
          const nested = /^[ \t]*(?:>[ \t]?)*$/.test(prefix);
          if (nested && (space || node.to === line.to)) {
            if (/^[ \t]*$/.test(prefix))
              ranges.push(
                Decoration.line({
                  class: "cm-quote cm-hang-b-0",
                }).range(line.from),
              );
            ranges.push(quoteBar.range(node.from, node.to + space));
          }
        } else if (node.name === "ListMark") {
          const mark = view.state.doc.sliceString(node.from, node.to);
          const after = view.state.doc.sliceString(node.to, node.to + 5);
          // Task items are drawn by their checkbox; ordered items keep their numbers.
          // The dot covers the marker and its space, so the text starts where wrapped lines do.
          if (/^[-*+]$/.test(mark) && /^[ \t]/.test(after) && !/^[ \t]+\[[ xX]\]/.test(after))
            ranges.push(bullet.range(node.from, node.to + 1));
        } else if (node.name === "TaskMarker") {
          const line = view.state.doc.lineAt(node.from);
          const prefix = view.state.doc.sliceString(line.from, node.from);
          const list = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+$/.exec(prefix);
          const from = list ? line.from + list[1].length : node.from;
          const checked = view.state.doc.sliceString(node.from + 1, node.from + 2) !== " ";
          ranges.push(
            Decoration.replace({
              atomic: true,
              widget: new TaskCheckbox(node.from + 1, checked, view.state.readOnly),
            }).range(
              from,
              // The checkbox covers its following space too (see the bullet above).
              view.state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to,
            ),
          );
          if (checked && node.to < line.to)
            ranges.push(Decoration.mark({ class: "cm-completed-task" }).range(node.to, line.to));
        } else if (node.name === "Image") {
          const source = view.state.doc.sliceString(node.from, node.to);
          const image = /^!\[([^\]\n]*)\]\(([^\s)]+)\)$/.exec(source);
          const name = imagePath.exec(image?.[2] ?? "")?.[1];
          const line = view.state.doc.lineAt(node.from);
          const editingLine =
            view.hasFocus &&
            view.state.selection.ranges.some(
              (range) => range.from <= line.to && range.to >= line.from,
            );
          if (name && image && !editingLine)
            ranges.push(
              Decoration.replace({
                atomic: true,
                widget: new RepositoryImage(name, image[1]),
              }).range(node.from, node.to),
            );
        } else if (node.name === "FencedCode") {
          // A code block shows as one panel. Its fences (and the language) are hidden unless the
          // caret is on that line, as in the Mac app; the Markdown itself is unchanged.
          const first = view.state.doc.lineAt(node.from);
          const last = view.state.doc.lineAt(node.to);
          const closes = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
          for (let number = first.number; number <= last.number; number++) {
            const line = view.state.doc.line(number);
            const fence = number === first.number || (number === last.number && closes);
            const editingLine =
              view.hasFocus &&
              view.state.selection.ranges.some(
                (range) => range.from <= line.to && range.to >= line.from,
              );
            const classes = ["cm-code-line"];
            if (number === first.number) classes.push("cm-code-first");
            if (number === last.number) classes.push("cm-code-last");
            if (fence) classes.push(editingLine ? "cm-code-fence" : "cm-fence-hidden");
            ranges.push(Decoration.line({ class: classes.join(" ") }).range(line.from));
            if (fence && !editingLine && line.to > line.from)
              ranges.push(Decoration.replace({}).range(line.from, line.to));
          }
        } else if (node.name === "HorizontalRule") {
          // "---" shows as a rule away from the caret (as the Mac app always drew it).
          const line = view.state.doc.lineAt(node.from);
          const editingLine =
            view.hasFocus &&
            view.state.selection.ranges.some(
              (range) => range.from <= line.to && range.to >= line.from,
            );
          if (!editingLine) {
            ranges.push(Decoration.line({ class: "cm-rule" }).range(line.from));
            ranges.push(Decoration.replace({}).range(node.from, node.to));
          }
        } else if (node.name === "HeaderMark") {
          const line = view.state.doc.lineAt(node.from);
          const editingLine =
            view.hasFocus &&
            view.state.selection.ranges.some(
              (range) => range.from <= line.to && range.to >= line.from,
            );
          if (!editingLine)
            ranges.push(
              Decoration.replace({ atomic: true }).range(node.from, Math.min(line.to, node.to + 1)),
            );
        }
      },
    });
  return Decoration.set(ranges, true);
}
const liveMarkdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = taskDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.state.readOnly !== update.startState.readOnly ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        this.decorations = taskDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** Hidden marks, widgets and their atomic ranges; dropped in raw (source) mode. */
const liveExtensions = [
  liveMarkdown,
  EditorView.atomicRanges.of(
    (view) =>
      view.plugin(liveMarkdown)?.decorations.update({
        filter: (_from, _to, value) => Boolean(value.spec.atomic),
      }) ?? Decoration.none,
  ),
];
const proseHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.8em", fontWeight: "700", color: "var(--color-text)" },
  { tag: tags.heading2, fontSize: "1.45em", fontWeight: "650", color: "var(--color-text)" },
  {
    tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    fontSize: "1.2em",
    fontWeight: "650",
  },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--color-accent)" },
  { tag: tags.monospace, fontFamily: "var(--font-code)", color: "var(--color-code-text)" },
  // Markdown syntax (list numbers, quote and emphasis marks) in the body font, quieter.
  { tag: tags.processingInstruction, color: "var(--color-text-muted)" },
  { tag: tags.meta, color: "var(--color-text-muted)" },
]);
/** Hanging indents per indentation (CSP forbids inline styles, so these are classes). */
const hangingIndents: Record<string, { paddingLeft: string; textIndent: string }> = {};
/** Each nesting level steps in by about one marker width, so levels are easy to tell apart. */
const nestingStep = "1.5rem";
const maxDepth = 8;
for (const [kind, width] of [
  ["b", "1.45rem"],
  ["o2", "1.95rem"],
  ["o3", "2.45rem"],
] as const)
  for (let depth = 0; depth <= maxDepth; depth++)
    // ".cm-line." outranks the theme's own ".cm-line" padding. The first line starts at the
    // depth's indent with the marker; wrapped lines start after the marker.
    hangingIndents[`.cm-line.cm-hang-${kind}-${depth}`] = {
      paddingLeft: `calc(${depth} * ${nestingStep} + ${width})`,
      textIndent: `calc(-1 * ${width})`,
    };
const noteTheme = EditorView.theme(
  {
    ...hangingIndents,
    "&": { backgroundColor: "transparent", color: "var(--color-text)", fontSize: "1rem" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "visible" },
    ".cm-content": { padding: "0.5rem 0 1rem", minHeight: "16rem", overflowWrap: "anywhere" },
    ".cm-line": { padding: "2px 0" },
    ".cm-cursor": { borderLeftColor: "var(--color-text)", transform: "scaleY(0.8)" },
    // Selection is translucent and drawn behind the text, so selected text stays readable. The
    // focused selector matches CodeMirror's own (more specific) one, which otherwise wins with an
    // opaque light-theme lavender.
    ".cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      { background: "color-mix(in srgb, var(--color-accent) 28%, transparent)" },
    ".cm-line::selection, .cm-line ::selection, .cm-content ::selection": {
      backgroundColor: "transparent",
    },
    // Checkboxes and bullets match the Mac app: a muted outlined box, a dot centred in the same
    // space, and item text starting at the same position for both.
    // Marker boxes are 1.45rem wide (the hanging indent): 0.1rem + 0.9rem mark + 0.45rem gap.
    // text-indent is reset: the line's negative hanging indent would otherwise move the box.
    ".cm-task-box": {
      display: "inline-block",
      width: "1.45rem",
      textIndent: "0",
      whiteSpace: "nowrap",
    },
    ".cm-task-checkbox": {
      appearance: "none",
      position: "relative",
      boxSizing: "border-box",
      width: "0.9rem",
      height: "0.9rem",
      padding: "0",
      margin: "0 0 0.15em 0.1rem",
      border: "1.5px solid var(--color-text-muted)",
      borderRadius: "0.22rem",
      backgroundColor: "transparent",
      verticalAlign: "middle",
      cursor: "pointer",
    },
    ".cm-task-checkbox:checked::after": {
      content: '""',
      position: "absolute",
      left: "0.24rem",
      top: "0.06rem",
      width: "0.22rem",
      height: "0.45rem",
      border: "solid var(--color-text-muted)",
      borderWidth: "0 1.5px 1.5px 0",
      transform: "rotate(45deg)",
    },
    ".cm-task-checkbox:focus-visible": {
      outline: "2px solid var(--color-accent)",
      outlineOffset: "2px",
    },
    ".cm-bullet": {
      position: "relative",
      display: "inline-block",
      width: "1.45rem",
      height: "0.9rem",
      margin: "0 0 0.15em 0",
      verticalAlign: "middle",
    },
    ".cm-bullet::before": {
      content: '""',
      position: "absolute",
      left: "0.4rem",
      top: "calc(50% - 0.15rem)",
      width: "0.3rem",
      height: "0.3rem",
      borderRadius: "50%",
      backgroundColor: "var(--color-text-muted)",
    },
    ".cm-code-line": {
      backgroundColor: "var(--color-code-bg)",
      padding: "0 1rem",
      fontFamily: "var(--font-code)",
    },
    ".cm-code-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px" },
    ".cm-code-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px" },
    ".cm-code-fence": { color: "var(--color-text-muted)", fontSize: "0.85em" },
    ".cm-fence-hidden": { fontSize: "0", lineHeight: "0.75rem", padding: "0 1rem" },
    ".cm-quote": { color: "var(--color-text-muted)" },
    ".cm-title-placeholder": {
      color: "var(--color-text-muted)",
      opacity: "0.6",
      pointerEvents: "none",
    },
    ".cm-ordered": { display: "inline-block", textIndent: "0", whiteSpace: "pre" },
    ".cm-ordered-1": { width: "1.45rem" },
    ".cm-ordered-2": { width: "1.95rem" },
    ".cm-ordered-3": { width: "2.45rem" },
    ".cm-inline-code": {
      padding: "0.1em 0.3em",
      borderRadius: "4px",
      backgroundColor: "var(--color-code-bg)",
      fontSize: "0.9em",
    },
    ".cm-link-label": { color: "var(--color-accent)", textDecoration: "underline" },
    ".cm-table": { fontFamily: "var(--font-code)", fontSize: "0.9em" },
    ".cm-rule": {
      backgroundImage:
        "linear-gradient(var(--color-border, #2d333b), var(--color-border, #2d333b))",
      backgroundSize: "100% 1px",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    },
    ".cm-quote-bar": {
      display: "inline-block",
      width: "3px",
      height: "1.2em",
      margin: "0 calc(1.35rem - 3px) -0.2em 0.1rem",
      borderRadius: "2px",
      backgroundColor: "var(--color-border, #2d333b)",
      verticalAlign: "baseline",
    },
    ".cm-completed-task": { color: "var(--color-text-muted)", textDecoration: "line-through" },
    ".cm-note-image": { maxWidth: "min(100%, 320px)", maxHeight: "240px", verticalAlign: "middle" },
  },
  { dark: true },
);

/** One document, one selection/undo history. Markdown is never split into form fields or reserialized. */
export const NoteView = forwardRef<
  NoteViewHandle,
  {
    markdown: string;
    onChange: (next: string, persist?: boolean) => void;
    focusAt?: number | null;
    readOnly?: boolean;
    /** Show the raw Markdown: no hidden marks, widgets or typing shortcuts (Mac source mode). */
    raw?: boolean;
    /** Resolves repository image names to URLs; the web app uses /api/assets/. */
    assetUrl?: (name: string) => string;
  }
>(function NoteView(
  { markdown: source, onChange, focusAt, readOnly = false, raw = false, assetUrl },
  ref,
) {
  const root = useRef<HTMLElement>(null);
  const editor = useRef<EditorView | null>(null);
  const access = useRef(new Compartment());
  const live = useRef(new Compartment());
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const change = useRef(onChange);
  change.current = onChange;
  /** The editor's text as last emitted or applied; echoing it back needs no comparison. */
  const synced = useRef(source);
  useImperativeHandle(
    ref,
    () => ({
      get value() {
        return editor.current?.state.sliceDoc() ?? "";
      },
      get selectionStart() {
        const state = editor.current?.state;
        return state ? state.sliceDoc(0, state.selection.main.from).length : 0;
      },
      get selectionEnd() {
        const state = editor.current?.state;
        return state ? state.sliceDoc(0, state.selection.main.to).length : 0;
      },
      focus() {
        editor.current?.focus();
      },
      setSelectionRange(start, end) {
        const view = editor.current;
        if (view) {
          const source = view.state.sliceDoc();
          view.dispatch({
            selection: {
              anchor: view.state.toText(source.slice(0, Math.max(0, start))).length,
              head: view.state.toText(source.slice(0, Math.max(0, end))).length,
            },
            scrollIntoView: true,
          });
        }
      },
      command(name) {
        return editor.current ? runCommand(editor.current, name) : false;
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!root.current) return;
    /** After "[]" becomes "- [ ] ", the space typed next would double the separator. */
    let absorbSpaceAt: number | null = null;
    /** The todo shortcut for text committed by an IME, once the composition has ended. */
    const composedShortcut = (view: EditorView, tries = 5) => {
      if (rawRef.current || view.state.readOnly) return;
      if (view.composing) {
        if (tries > 0) setTimeout(() => composedShortcut(view, tries - 1), 20);
        return;
      }
      const { head, empty } = view.state.selection.main;
      const doc = view.state.doc.toString();
      if (!empty || !/[\]］」]$/.test(doc.slice(0, head))) return;
      const todo = todoShortcut(doc, head);
      if (!todo) return;
      view.dispatch({
        changes: { from: todo.from, to: todo.to, insert: todo.insert },
        selection: { anchor: todo.from + todo.insert.length },
        userEvent: "input.autoformat",
        annotations: isolateHistory.of("before"),
      });
      if (todo.absorbSpace) absorbSpaceAt = todo.from + todo.insert.length;
    };
    const view = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: source,
        extensions: [
          EditorState.lineSeparator.of(source.includes("\r\n") ? "\r\n" : "\n"),
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          access.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          keymap.of([
            {
              key: "Enter",
              run: (view) =>
                sharedCommand(closeFence)(view) ||
                sharedCommand(codeIndent)(view) ||
                sharedCommand(breakBeforeHeading)(view) ||
                sharedCommand(continueList)(view) ||
                insertNewline(view),
            },
            {
              key: "Backspace",
              run: (view) => sharedCommand(deleteMarker)(view) || deleteMarkupBackward(view),
            },
            {
              key: "Delete",
              run: (view) => sharedCommand(joinNextItem)(view) || deleteCharForward(view),
            },
            {
              key: "Shift-Enter",
              run: (view) => sharedCommand(softBreak)(view) || insertNewline(view),
            },
            { mac: "Mod-Backspace", run: sharedCommand(deleteToMarker) },
            {
              // List items indent as a whole; elsewhere Tab inserts a tab at the caret.
              key: "Tab",
              run: (view) =>
                sharedCommand((text, caret) => indentItem(text, caret, false))(view) ||
                insertTab(view),
              shift: (view) =>
                sharedCommand((text, caret) => indentItem(text, caret, true))(view) ||
                indentLess(view),
            },
            { key: "Alt-ArrowUp", run: (view) => moveSelectedLines(view, true) },
            { key: "Alt-ArrowDown", run: (view) => moveSelectedLines(view, false) },
            { key: "Home", run: smartLineStart },
            { mac: "Cmd-ArrowLeft", run: smartLineStart },
            { key: "Mod-Enter", run: toggleTaskCommand },
            // Formatting lives in the editor's keymap (not only the page), so CodeMirror's own
            // bindings (⌘I selects the syntax node, ⌘L selects the line) never take these keys,
            // and the Mac app gets the same shortcuts.
            { key: "Mod-b", run: (view) => runCommand(view, "bold") },
            { key: "Mod-i", run: (view) => runCommand(view, "italic") },
            { key: "Mod-Shift-x", run: (view) => runCommand(view, "strike") },
            { key: "Mod-Shift-`", run: (view) => runCommand(view, "code") },
            { key: "Mod-l", run: (view) => runCommand(view, "link") },
            { key: "Mod-Alt-[", run: (view) => runCommand(view, "heading-prev") },
            { key: "Mod-Alt-]", run: (view) => runCommand(view, "heading-next") },
          ]),
          // The bare GFM language, not markdown(): that always bundles HTML, CSS and JavaScript
          // parsers (about a fifth of the app) for inline HTML, which this editor never styles.
          // Its keymap, HTML completion and URL paste are replaced by our own commands anyway.
          markdownLanguage,
          keymap.of([...historyKeymap, ...defaultKeymap]),
          syntaxHighlighting(proseHighlight),
          live.current.of(raw ? [] : liveExtensions),
          noteTheme,
          ...(assetUrl ? [assetSource.of(assetUrl)] : []),
          EditorView.inputHandler.of((view, from, to, insert) => {
            const absorb = absorbSpaceAt;
            absorbSpaceAt = null;
            if (rawRef.current) return false;
            if (from !== to && !view.state.readOnly && !view.composing) {
              const wrapped = wrapOnType(
                view.state.doc.toString(),
                { start: from, end: to },
                insert,
              );
              if (wrapped) {
                applyEdit(view, view.state.doc.toString(), wrapped, "input.type");
                return true;
              }
            }
            if (insert === " " && from === to && from === absorb) return true;
            // IME input is left to CodeMirror (intercepting it duplicated the composed text);
            // the shortcut is applied once the composition is committed (see the listener).
            if (view.composing || view.compositionStarted) return false;
            if (!/[\]］」]$/.test(insert) || view.state.readOnly) return false;
            const doc = view.state.doc.toString();
            const typed = doc.slice(0, from) + insert + doc.slice(to);
            const caret = from + insert.length;
            const todo = todoShortcut(typed, caret);
            if (!todo) return false;
            // The typed bracket first, then the conversion as its own undo step, so ⌘Z turns
            // "- [ ] " back into the "[]" you typed (as other editors' autoformat does).
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: caret },
              userEvent: "input.type",
            });
            view.dispatch({
              changes: { from: todo.from, to: caret, insert: todo.insert },
              selection: { anchor: todo.from + todo.insert.length },
              userEvent: "input.autoformat",
              annotations: [isolateHistory.of("before"), Transaction.addToHistory.of(true)],
            });
            if (todo.absorbSpace) absorbSpaceAt = todo.from + todo.insert.length;
            return true;
          }),
          // A URL pasted over selected text becomes [text](url). Done on CodeMirror's own paste
          // transaction so its selection handling stays intact.
          EditorState.transactionFilter.of((tr) => {
            if (!tr.isUserEvent("input.paste") || !tr.docChanged) return tr;
            const range = tr.startState.selection.main;
            if (range.empty || tr.startState.selection.ranges.length > 1) return tr;
            let pasted: string | undefined;
            let replacesSelection = true;
            tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
              if (pasted !== undefined || fromA !== range.from || toA !== range.to)
                replacesSelection = false;
              pasted = inserted.toString();
            });
            if (!replacesSelection || pasted === undefined) return tr;
            const previous = tr.startState.doc.toString();
            const link = pasteLink(previous, { start: range.from, end: range.to }, pasted);
            if (!link) return tr;
            return {
              changes: minimalChange(previous, link.text),
              selection: { anchor: link.start },
              userEvent: "input.paste",
              scrollIntoView: true,
            };
          }),
          EditorView.domEventHandlers({
            compositionend(_event, view) {
              setTimeout(() => composedShortcut(view));
              return false;
            },
            mousedown(event, view) {
              // ⌘-click (Ctrl-click elsewhere) opens a link, as in the Mac app.
              if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) return false;
              const line = view.state.doc.lineAt(pos);
              const href = linkAt(line.text, pos - line.from);
              if (!href) return false;
              let url: URL;
              try {
                url = new URL(href);
              } catch {
                return false;
              }
              if (url.protocol !== "https:" && url.protocol !== "http:") return false;
              event.preventDefault();
              const link = document.createElement("a");
              link.href = url.href;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              link.click();
              return true;
            },
          }),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown本文",
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet && update.state.selection.main.head !== absorbSpaceAt)
              absorbSpaceAt = null;
            // "「」" committed by the Japanese IME at a line start becomes a todo, like "[]".
            if (
              update.docChanged &&
              update.transactions.some((transaction) =>
                transaction.isUserEvent("input.type.compose"),
              )
            )
              setTimeout(() => composedShortcut(update.view));
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(externalChange))
            ) {
              synced.current = update.state.sliceDoc();
              change.current(
                synced.current,
                update.transactions.some((transaction) => transaction.annotation(persistTask)),
              );
            }
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    editor.current?.dispatch({
      effects: access.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);
  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: live.current.reconfigure(raw ? [] : liveExtensions) });
  }, [raw]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || source === synced.current) return;
    synced.current = source;
    if (view.state.sliceDoc() === source) return;
    const incoming = view.state.toText(source);
    const next = incoming.toString();
    const previous = view.state.doc.toString();
    let from = 0,
      end = previous.length,
      nextEnd = next.length;
    while (from < end && from < nextEnd && previous[from] === next[from]) from++;
    while (end > from && nextEnd > from && previous[end - 1] === next[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    view.dispatch({
      changes: { from, to: end, insert: incoming.slice(from, nextEnd) },
      annotations: externalChange.of(true),
    });
  }, [source]);
  useLayoutEffect(() => {
    const view = editor.current;
    if (view && focusAt != null) {
      view.dispatch({ selection: { anchor: Math.min(focusAt, view.state.doc.length) } });
      view.focus();
    }
  }, [focusAt]);
  return <article ref={root} className="note document-editor" aria-label="ノート" />;
});
