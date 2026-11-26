import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  continueList,
  findMatch,
  headingCaret,
  indentItem,
  insertLink,
  toggleTask,
  wrapSelection,
  type Document,
  type Span,
} from "@descartes/shared";
import type { NoteViewHandle } from "./NoteView";
import { actionFor } from "./shortcuts";

/**
 * The page's keyboard shortcuts (window keydown). Edits made here replace the whole text, so the
 * selection they produce is applied once the editor shows that text.
 */
export function useShortcuts({
  busy,
  current,
  query,
  text,
  save,
  switchTo,
  area,
  finder,
  help,
  pending,
  latestText,
  setText,
  setPicking,
  setFinding,
  setZoom,
}: {
  busy: boolean;
  current: Document | undefined;
  query: string;
  text: string;
  save: () => Promise<void>;
  switchTo: (id?: string) => void;
  area: RefObject<NoteViewHandle | null>;
  finder: RefObject<HTMLInputElement | null>;
  help: RefObject<HTMLDialogElement | null>;
  pending: RefObject<Span | null>;
  latestText: RefObject<string>;
  setText: Dispatch<SetStateAction<string>>;
  setPicking: Dispatch<SetStateAction<boolean>>;
  setFinding: Dispatch<SetStateAction<boolean>>;
  setZoom: Dispatch<SetStateAction<number>>;
}) {
  useEffect(() => {
    const range = pending.current;
    if (!range || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(range.start, range.end);
    pending.current = null;
  }, [text]);
  useEffect(() => {
    function edit(next: { text: string; start: number; end: number }) {
      pending.current = next;
      latestText.current = next.text;
      setText(next.text);
    }
    function jump(forward: boolean) {
      const field = area.current;
      if (!field) return;
      const caret = headingCaret(field.value, field.selectionStart, forward);
      if (caret === undefined) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    }
    function find(forward: boolean) {
      const field = area.current;
      if (!field) return;
      const from = forward ? field.selectionEnd : field.selectionStart;
      const match = findMatch(field.value, query, from, forward);
      if (!match) return;
      field.focus();
      field.setSelectionRange(match.start, match.end);
    }
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const action = actionFor(event);
      if (!action || busy || event.isComposing) return;
      const target = event.target;
      const typingFind = target === finder.current;
      // Inputs inside the note switcher and help handle their own keys.
      if (target instanceof Element && target.closest("dialog")) return;
      if (target instanceof Element && target.closest(".note") && !event.metaKey && !event.ctrlKey)
        return;
      if (typingFind && action === "continue") {
        event.preventDefault();
        find(true);
        return;
      }
      if (typingFind && (action === "continue" || action === "indent" || action === "outdent"))
        return;
      const field = area.current;
      const span = { start: field?.selectionStart ?? 0, end: field?.selectionEnd ?? 0 };
      const body = field?.value ?? text;
      if (action === "new") {
        event.preventDefault();
        switchTo();
      } else if (action === "save") {
        event.preventDefault();
        void save();
      } else if (action === "search") {
        event.preventDefault();
        setPicking(true);
      } else if (action === "help") {
        event.preventDefault();
        help.current?.showModal();
      } else if (action === "edit") {
        event.preventDefault();
        if (field) edit(wrapSelection(body, span, "`"));
      } else if (action === "find") {
        event.preventDefault();
        setFinding(true);
        requestAnimationFrame(() => finder.current?.focus());
      } else if (action === "find-next" || action === "find-prev") {
        event.preventDefault();
        find(action === "find-next");
      } else if (action === "zoom-in" || action === "zoom-out" || action === "zoom-reset") {
        event.preventDefault();
        setZoom((value) =>
          action === "zoom-reset"
            ? 10
            : Math.min(20, Math.max(5, value + (action === "zoom-in" ? 1 : -1))),
        );
      } else if (action === "heading-prev" || action === "heading-next") {
        event.preventDefault();
        jump(action === "heading-next");
      } else if (!field) {
        return;
      } else if (action === "continue") {
        const next = continueList(body, span.start);
        if (!next || span.start !== span.end) return;
        event.preventDefault();
        edit(next);
      } else if (action === "indent" || action === "outdent") {
        if (span.start !== span.end) return;
        const next = indentItem(body, span.start, action === "outdent");
        if (!next) return;
        event.preventDefault();
        edit(next);
      } else if (action === "task") {
        const next = toggleTask(body, span.start);
        if (!next) return;
        event.preventDefault();
        edit(next);
      } else if (
        action === "bold" ||
        action === "italic" ||
        action === "code" ||
        action === "strike"
      ) {
        event.preventDefault();
        const delimiters = { bold: "**", italic: "*", code: "`", strike: "~~" } as const;
        edit(wrapSelection(body, span, delimiters[action]));
      } else if (action === "link") {
        event.preventDefault();
        edit(insertLink(body, span));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, current, query, save, switchTo, text]);
}
