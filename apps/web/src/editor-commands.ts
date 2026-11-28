import { EditorView, keymap } from "@codemirror/view";
import { Annotation, EditorState } from "@codemirror/state";
import {
  deleteCharForward,
  indentLess,
  insertNewline,
  insertTab,
  redo,
  undo,
} from "@codemirror/commands";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";
import {
  breakBeforeHeading,
  closeFence,
  codeIndent,
  continueList,
  deleteMarker,
  deleteToMarker,
  headingCaret,
  indentItem,
  insertLink,
  joinNextItem,
  markerEnd,
  moveLines,
  pasteLink,
  softBreak,
  toggleTask,
  wrapSelection,
  type Span,
} from "@descartes/shared";

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
  | "indent"
  | "outdent"
  | "undo"
  | "redo";
/** Marks an edit that should be saved at once, like a checkbox click. */
export const persistTask = Annotation.define<boolean>();
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
export function applyEdit(
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
    case "indent":
    case "outdent":
      // Same rule as Tab / ⇧Tab on a list item; elsewhere there is nothing to nest.
      return sharedCommand((text, caret) => indentItem(text, caret, name === "outdent"))(view);
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

/** Runs before the Markdown language and default keymaps, so these bindings win. */
export const noteKeymap = keymap.of([
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
      sharedCommand((text, caret) => indentItem(text, caret, false))(view) || insertTab(view),
    shift: (view) =>
      sharedCommand((text, caret) => indentItem(text, caret, true))(view) || indentLess(view),
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
]);
/**
 * A URL pasted over selected text becomes [text](url). Done on CodeMirror's own paste
 * transaction so its selection handling stays intact.
 */
export const pasteAsLink = EditorState.transactionFilter.of((tr) => {
  if (!tr.isUserEvent("input.paste") || !tr.docChanged) return tr;
  const range = tr.startState.selection.main;
  if (range.empty || tr.startState.selection.ranges.length > 1) return tr;
  let pasted: string | undefined;
  let replacesSelection = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (pasted !== undefined || fromA !== range.from || toA !== range.to) replacesSelection = false;
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
});
