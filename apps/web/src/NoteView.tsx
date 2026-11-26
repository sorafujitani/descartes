import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { linkAt, todoShortcut, wrapOnType } from "@descartes/shared";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { defaultKeymap, history, isolateHistory, historyKeymap } from "@codemirror/commands";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import {
  applyEdit,
  noteKeymap,
  pasteAsLink,
  persistTask,
  runCommand,
  type EditCommand,
} from "./editor-commands";
import { noteTheme, proseHighlight } from "./editor-theme";
import { assetSource, liveExtensions } from "./live-markdown";

export { assetSource } from "./live-markdown";
export { runCommand, type EditCommand } from "./editor-commands";
export type NoteViewHandle = {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  /** Runs an editing command (menus, the Mac app's bridge); false when it does not apply. */
  command(name: EditCommand): boolean;
};
const externalChange = Annotation.define<boolean>();

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
          noteKeymap,
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
          pasteAsLink,
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
