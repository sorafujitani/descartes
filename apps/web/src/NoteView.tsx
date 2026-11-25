import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  breakBeforeHeading,
  closeFence,
  continueList,
  deleteMarker,
  imagePath,
  indentItem,
  linkAt,
  moveLines,
  pasteLink,
  wrapOnType,
  markerEnd,
  todoShortcut,
  toggleTask,
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
  history,
  historyKeymap,
  indentLess,
  insertNewline,
  insertTab,
} from "@codemirror/commands";
import { deleteMarkupBackward, markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export type NoteViewHandle = {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
};
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
    if (!(dom instanceof HTMLInputElement) || dom.type !== "checkbox") return false;
    const input = dom;
    input.checked = this.checked;
    input.disabled = this.disabled;
    input.dataset.at = String(this.at);
    return true;
  }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task-checkbox";
    input.setAttribute("aria-label", "チェックを切り替える");
    this.updateDOM(input);
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
    return input;
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
    image.src = "/api/assets/" + this.name;
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
function taskDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  for (const visible of view.visibleRanges)
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (node.name === "ListMark") {
          // Wrapped item text lines up after its dot, checkbox or number (as in the Mac app).
          const line = view.state.doc.lineAt(node.from);
          const indent = Math.min(12, node.from - line.from);
          const mark = view.state.doc.sliceString(node.from, node.to);
          const task = /^[ \t]+\[[ xX]\]/.test(view.state.doc.sliceString(node.to, node.to + 5));
          const kind = task || /^[-*+]$/.test(mark) ? "b" : mark.length > 2 ? "o2" : "o1";
          ranges.push(Decoration.line({ class: `cm-hang-${kind}-${indent}` }).range(line.from));
        }
        if (node.name === "QuoteMark") {
          // The first "> " on a line becomes a quote bar (the Mac app hides it the same way).
          const line = view.state.doc.lineAt(node.from);
          const prefix = view.state.doc.sliceString(line.from, node.from);
          const space = view.state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
          if (/^[ \t]*$/.test(prefix) && (space || node.to === line.to)) {
            ranges.push(
              Decoration.line({
                class: `cm-quote cm-hang-b-${Math.min(12, node.from - line.from)}`,
              }).range(line.from),
            );
            ranges.push(quoteBar.range(node.from, node.to + space));
          }
        } else if (node.name === "ListMark") {
          const mark = view.state.doc.sliceString(node.from, node.to);
          const after = view.state.doc.sliceString(node.to, node.to + 5);
          // Task items are drawn by their checkbox; ordered items keep their numbers.
          if (/^[-*+]$/.test(mark) && /^[ \t]/.test(after) && !/^[ \t]+\[[ xX]\]/.test(after))
            ranges.push(bullet.range(node.from, node.to));
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
            }).range(from, node.to),
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
  {
    tag: [tags.monospace, tags.processingInstruction],
    fontFamily: "var(--font-code)",
    color: "var(--color-code-text)",
  },
  { tag: tags.meta, color: "var(--color-text-muted)" },
]);
/** Hanging indents per indentation (CSP forbids inline styles, so these are classes). */
const hangingIndents: Record<string, { paddingLeft: string; textIndent: string }> = {};
for (const [kind, width] of [
  ["b", "1.45rem"],
  ["o1", "1.3em"],
  ["o2", "1.85em"],
] as const)
  for (let indent = 0; indent <= 12; indent++) {
    const hang = `calc(${indent} * 0.28em + ${width})`;
    // ".cm-line." outranks the theme's own ".cm-line" padding.
    hangingIndents[`.cm-line.cm-hang-${kind}-${indent}`] = {
      paddingLeft: hang,
      textIndent: `calc(-1 * ${hang})`,
    };
  }
const noteTheme = EditorView.theme({
  ...hangingIndents,
  "&": { backgroundColor: "transparent", color: "var(--color-text)", fontSize: "1rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "visible" },
  ".cm-content": { padding: "0.5rem 0 1rem", minHeight: "16rem", overflowWrap: "anywhere" },
  ".cm-line": { padding: "2px 0" },
  ".cm-cursor": { borderLeftColor: "var(--color-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 25%, transparent)",
  },
  // Checkboxes and bullets match the Mac app: a muted outlined box, a dot centred in the same
  // space, and item text starting at the same position for both.
  ".cm-task-checkbox": {
    appearance: "none",
    position: "relative",
    boxSizing: "border-box",
    width: "0.9rem",
    height: "0.9rem",
    padding: "0",
    margin: "0 0.45rem 0.15em 0.1rem",
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
    width: "0.9rem",
    height: "0.9rem",
    margin: "0 0.45rem 0.15em 0.1rem",
    verticalAlign: "middle",
  },
  ".cm-bullet::before": {
    content: '""',
    position: "absolute",
    left: "calc(50% - 0.15rem)",
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
});

/** One document, one selection/undo history. Markdown is never split into form fields or reserialized. */
export const NoteView = forwardRef<
  NoteViewHandle,
  {
    markdown: string;
    onChange: (next: string, persist?: boolean) => void;
    focusAt?: number | null;
    readOnly?: boolean;
  }
>(function NoteView({ markdown: source, onChange, focusAt, readOnly = false }, ref) {
  const root = useRef<HTMLElement>(null);
  const editor = useRef<EditorView | null>(null);
  const access = useRef(new Compartment());
  const change = useRef(onChange);
  change.current = onChange;
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
    }),
    [],
  );
  useLayoutEffect(() => {
    if (!root.current) return;
    /** After "[]" becomes "- [ ] ", the space typed next would double the separator. */
    let absorbSpaceAt: number | null = null;
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
                sharedCommand(breakBeforeHeading)(view) ||
                sharedCommand(continueList)(view) ||
                insertNewline(view),
            },
            {
              key: "Backspace",
              run: (view) => sharedCommand(deleteMarker)(view) || deleteMarkupBackward(view),
            },
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
            {
              key: "Mod-Enter",
              run(view) {
                if (view.state.readOnly) return true;
                const previous = view.state.doc.toString();
                const { from, to } = view.state.selection.main;
                const next = toggleTask(previous, from, to);
                if (next) {
                  // Checking or unchecking saves like a checkbox click; creating a todo is an edit.
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
              },
            },
          ]),
          markdown({
            base: markdownLanguage,
            addKeymap: false,
            completeHTMLTags: false,
            // Our pasteLink (shared with the Mac app) puts the caret after the link instead.
            pasteURLAsLink: false,
          }),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          syntaxHighlighting(proseHighlight),
          liveMarkdown,
          noteTheme,
          EditorView.atomicRanges.of(
            (view) =>
              view.plugin(liveMarkdown)?.decorations.update({
                filter: (_from, _to, value) => Boolean(value.spec.atomic),
              }) ?? Decoration.none,
          ),
          EditorView.inputHandler.of((view, from, to, insert) => {
            const absorb = absorbSpaceAt;
            absorbSpaceAt = null;
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
            if (!/[\]］」]$/.test(insert) || view.state.readOnly) return false;
            const doc = view.state.doc.toString();
            const typed = doc.slice(0, from) + insert + doc.slice(to);
            const caret = from + insert.length;
            const todo = todoShortcut(typed, caret);
            if (!todo) return false;
            view.dispatch({
              changes: { from: todo.from, to, insert: todo.insert },
              selection: { anchor: todo.from + todo.insert.length },
              userEvent: "input.type",
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
            mousedown(event, view) {
              // ⌘-click (Ctrl-click elsewhere) opens a link, as in the Mac app.
              if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos == null) return false;
              const line = view.state.doc.lineAt(pos);
              const url = linkAt(line.text, pos - line.from);
              if (!url) return false;
              event.preventDefault();
              window.open(url, "_blank", "noopener,noreferrer");
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
            if (
              update.docChanged &&
              !update.transactions.some((transaction) => transaction.annotation(externalChange))
            )
              change.current(
                update.state.sliceDoc(),
                update.transactions.some((transaction) => transaction.annotation(persistTask)),
              );
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
    const view = editor.current;
    if (!view || view.state.sliceDoc() === source) return;
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
