import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { imagePath, toggleTask } from "@descartes/shared";
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
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
  markdownLanguage,
} from "@codemirror/lang-markdown";
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
    const input = dom as HTMLInputElement;
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
        if (node.name === "TaskMarker") {
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
const noteTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--color-text)", fontSize: "1rem" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "visible" },
  ".cm-content": { padding: "0.5rem 0 1rem", minHeight: "16rem", overflowWrap: "anywhere" },
  ".cm-line": { padding: "2px 0" },
  ".cm-cursor": { borderLeftColor: "var(--color-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-accent) 25%, transparent)",
  },
  ".cm-task-checkbox": {
    width: "1.1rem",
    height: "1.1rem",
    padding: "0",
    margin: "0 0.4rem 0 0",
    verticalAlign: "middle",
    accentColor: "var(--color-accent)",
    cursor: "pointer",
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
            { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
            { key: "Backspace", run: deleteMarkupBackward },
            {
              key: "Mod-Enter",
              run(view) {
                if (view.state.readOnly) return true;
                const next = toggleTask(view.state.doc.toString(), view.state.selection.main.head);
                if (next) {
                  const previous = view.state.doc.toString();
                  let at = 0;
                  while (at < previous.length && previous[at] === next.text[at]) at++;
                  if (at < previous.length)
                    view.dispatch({
                      changes: { from: at, to: at + 1, insert: next.text[at] },
                      annotations: persistTask.of(true),
                      userEvent: "input.task",
                    });
                }
                return true;
              },
            },
          ]),
          markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false }),
          keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
          syntaxHighlighting(proseHighlight),
          liveMarkdown,
          noteTheme,
          EditorView.atomicRanges.of(
            (view) =>
              view.plugin(liveMarkdown)?.decorations.update({
                filter: (_from, _to, value) => Boolean(value.spec.atomic),
              }) ?? Decoration.none,
          ),
          EditorView.contentAttributes.of({
            "aria-label": "Markdown本文",
            "aria-multiline": "true",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
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
