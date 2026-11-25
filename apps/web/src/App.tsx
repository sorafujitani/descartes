import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { NotePalette, recentNotes, rememberNote } from "./NotePalette";
import { NoteView, type NoteViewHandle } from "./NoteView";
import { useDocuments } from "./useDocuments";
import {
  client,
  continueList,
  findMatch,
  headingCaret,
  indentItem,
  insertLink,
  messageOf,
  shortcutHelp,
  toggleTask,
  titleOf,
  wrapSelection,
  ApiError,
  type Document,
  type Span,
} from "@descartes/shared";
import { actionFor } from "./shortcuts";
const defaultId = new URLSearchParams(location.search).get("doc");
const defaultApi = client(location.origin),
  blank = "# ";
/**
 * Autosave waits for a pause in typing, but never leaves continuous typing unsaved for longer than
 * the maximum delay. Every save is a Git commit, and GitHub limits content-creating requests
 * (roughly 80 per minute and 500 per hour), so saves are coalesced instead of sent per keystroke.
 */
export const autosaveTiming = { idle: 4_000, max: 45_000, retry: 30_000 };
const untitled = "1行目に「# タイトル」を入力してください。";
export function App({
  api = defaultApi,
  initialId: requestedId,
}: {
  api?: ReturnType<typeof client>;
  /** A note to open; `null` starts a new one. Unset: ?doc=, or else the most recent note. */
  initialId?: string | null;
}) {
  const [initialId] = useState(() =>
    requestedId !== undefined ? requestedId : (defaultId ?? recentNotes()[0] ?? null),
  );
  const { docs, loading: listing, error: listError, revision, upsert } = useDocuments(api);
  const [current, setCurrent] = useState<Document>(),
    [text, setText] = useState(blank);
  const [busy, setBusy] = useState(Boolean(initialId)),
    [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const operation = useRef(Boolean(initialId));
  const latestText = useRef(text);
  latestText.current = text;
  /** Incremented whenever another document is shown, so late save responses cannot apply to it. */
  const session = useRef(0);
  /** A conflict stops autosave until an explicit save succeeds or another document is opened. */
  const pausedRef = useRef(false);
  const upload = useRef<HTMLInputElement>(null);
  const area = useRef<NoteViewHandle>(null);
  const [noteSession, setNoteSession] = useState(0);
  const finder = useRef<HTMLInputElement>(null);
  const help = useRef<HTMLDialogElement>(null);
  const pending = useRef<Span | null>(null);
  const [zoom, setZoom] = useState(() => {
    const saved = Number(localStorage.getItem("noteZoomTenths"));
    return Number.isInteger(saved) && saved >= 5 && saved <= 20 ? saved : 10;
  });
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const dirty = text !== (current?.markdown ?? blank);
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController();
    void api
      .get(initialId, controller.signal)
      .then((doc) => {
        if (controller.signal.aborted) return;
        currentRef.current = doc;
        latestText.current = doc.markdown;
        setCurrent(doc);
        setText(doc.markdown);
        setNoteSession((value) => value + 1);
        rememberNote(doc.id);
      })
      .catch((error) => {
        // A remembered note that was deleted elsewhere just leaves a new note open.
        if (!controller.signal.aborted && initialId === (requestedId ?? defaultId))
          setError(messageOf(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          operation.current = false;
          setBusy(false);
        }
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      // Start saving immediately, but still warn: the save is not confirmed until it is acknowledged.
      autosaveRef.current(true);
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  /** Blocking operations (loading, switching, uploading). Saves run separately and never block typing. */
  const run = useCallback(async (fn: () => Promise<void>) => {
    if (operation.current) return false;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (error) {
      setError(messageOf(error));
      return false;
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }, []);
  const select = useCallback((doc?: Document) => {
    currentRef.current = doc;
    if (doc) rememberNote(doc.id);
    latestText.current = doc?.markdown ?? blank;
    session.current++;
    pausedRef.current = false;
    setNoteSession((session) => session + 1);
    setCurrent(doc);
    setText(doc?.markdown ?? blank);
    try {
      const url = new URL(location.href);
      if (doc) url.searchParams.set("doc", doc.id);
      else url.searchParams.delete("doc");
      history.replaceState(null, "", url);
    } catch {
      /* location.href is always a valid URL in a browser. */
    }
  }, []);
  const unsaved = () => latestText.current !== (currentRef.current?.markdown ?? blank);
  const switchTo = useCallback(
    (id?: string) => {
      if (operation.current) return;
      void run(async () => {
        // Save before leaving; ask only when the latest text could not be saved.
        await flush();
        if (unsaved() && !confirm("保存できなかった変更を破棄しますか？")) return;
        select(id ? await api.get(id) : undefined);
      });
    },
    [run, select],
  );
  /** ⌘S saves now (otherwise autosave does). It also retries after a conflict or a failure. */
  async function save() {
    if (operation.current || !unsaved()) return;
    if (!titleOf(latestText.current)) {
      setError(untitled);
      return;
    }
    pausedRef.current = false;
    await flush();
  }
  async function attach(file?: File) {
    if (!file) return;
    await run(async () => {
      if (file.size > 4 * 1024 * 1024) throw new Error("画像は4 MiB以下にしてください。");
      const { path } = await api.attach(file);
      setText((t) => t + "\n\n![スクリーンショット](" + path + ")\n");
    });
  }
  const currentRef = useRef(current);
  currentRef.current = current;
  const writing = useRef<{ draft: string; again: boolean; promise: Promise<boolean> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirtySince = useRef<number | null>(null);
  function schedule(delay: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => autosaveRef.current(), delay);
  }
  /**
   * Saves the latest text with one request at a time, each based on the SHA acknowledged by the
   * previous one. A call while a save is in flight joins it and, if the text has changed since that
   * save started, queues exactly one more save of the newest text. Resolves `false` on failure.
   */
  function flush(keepalive = false): Promise<boolean> {
    const active = writing.current;
    if (active) {
      if (latestText.current !== active.draft) active.again = true;
      return active.promise;
    }
    if (!unsaved()) return Promise.resolve(true);
    const state = { draft: latestText.current, again: false, promise: Promise.resolve(true) };
    writing.current = state;
    state.promise = (async () => {
      const owner = session.current;
      try {
        while (true) {
          const draft = latestText.current;
          const base = currentRef.current;
          if (draft === (base?.markdown ?? blank)) return true;
          if (!titleOf(draft)) return false;
          state.draft = draft;
          state.again = false;
          const doc = await api.save(draft, base, { keepalive });
          keepalive = false;
          upsert(doc);
          rememberNote(doc.id);
          if (owner !== session.current) return true;
          currentRef.current = doc;
          // The response acknowledges only the submitted snapshot, never newer keystrokes.
          setCurrent(doc);
          setError("");
          try {
            const url = new URL(location.href);
            url.searchParams.set("doc", doc.id);
            history.replaceState(null, "", url);
          } catch {
            /* location.href is always a valid URL in a browser. */
          }
          if (!state.again) return true;
        }
      } catch (error) {
        if (owner !== session.current) return false;
        setError(messageOf(error));
        if (error instanceof ApiError && error.status === 409) {
          // Retrying cannot resolve a conflict; keep the draft and wait for the user.
          pausedRef.current = true;
          setError(
            messageOf(error) +
              " 自動保存を止めています。内容を控えてから開き直すか、⌘S で上書きを再試行してください。",
          );
        } else schedule(autosaveTiming.retry);
        return false;
      } finally {
        writing.current = null;
      }
    })();
    return state.promise;
  }
  /** Saves quietly when allowed; untitled drafts and paused (conflicting) notes are left alone. */
  function autosave(keepalive = false) {
    dirtySince.current = null;
    if (pausedRef.current || operation.current || !unsaved()) return;
    if (!titleOf(latestText.current)) return;
    void flush(keepalive);
  }
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  useEffect(() => {
    if (!dirty) {
      dirtySince.current = null;
      clearTimeout(timer.current);
      return;
    }
    const now = Date.now();
    dirtySince.current ??= now;
    schedule(
      Math.max(0, Math.min(autosaveTiming.idle, dirtySince.current + autosaveTiming.max - now)),
    );
  }, [text, dirty]);
  useEffect(() => {
    // Leaving the window, hiding the tab (the last reliable moment on mobile) or closing it saves now.
    const now = () => autosaveRef.current();
    const hidden = () => {
      if (document.visibilityState === "hidden") autosaveRef.current(true);
    };
    const leaving = () => autosaveRef.current(true);
    window.addEventListener("blur", now);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    return () => {
      window.removeEventListener("blur", now);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
      clearTimeout(timer.current);
    };
  }, []);
  function updateNote(next: string, persist = false) {
    latestText.current = next;
    setText(next);
    if (!persist) return;
    void flush();
  }
  useEffect(() => localStorage.setItem("noteZoomTenths", String(zoom)), [zoom]);
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
  const title = titleOf(text);
  useEffect(() => {
    document.title = title ? title + " — Descartes" : "Descartes";
  }, [title]);
  return (
    <>
      <header className="topbar">
        <button
          type="button"
          className="note-switcher"
          aria-label="ノート一覧"
          title="ノート一覧 (⌘P)"
          onClick={() => setPicking(true)}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
            <path
              d="M2 3.5h12M2 8h12M2 12.5h8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span className="note-title">{title || "新規ノート"}</span>
        </button>
        <div className="topbar-actions">
          {finding && (
            <input
              ref={finder}
              type="search"
              aria-label="本文検索"
              placeholder="本文を検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFinding(false);
                  area.current?.focus();
                }
              }}
            />
          )}
          <button
            type="button"
            className="icon"
            aria-label="新規ノート"
            title="新規ノート (⌘N)"
            disabled={busy}
            onClick={() => switchTo()}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
              <path
                d="M8 3v10M3 8h10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="icon"
            aria-label="画像を添付"
            title="画像を添付"
            disabled={busy}
            onClick={() => upload.current?.click()}
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
              <rect
                x="2"
                y="3"
                width="12"
                height="10"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M3.5 11.5l3-3 2 2 1.5-1.5 2.5 2.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <circle cx="10.5" cy="6" r="1" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="icon"
            aria-label="ショートカット"
            title="ショートカット (⌘K)"
            onClick={() => help.current?.showModal()}
          >
            ?
          </button>
        </div>
        <input
          hidden
          ref={upload}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            void attach(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </header>
      <main className="page">
        <div className="sheet" style={{ "--note-zoom": zoom / 10 } as CSSProperties}>
          <NoteView
            key={noteSession}
            ref={area}
            markdown={text}
            onChange={updateNote}
            readOnly={busy}
            focusAt={!current && !busy ? 2 : null}
          />
        </div>
      </main>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="閉じる" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      <NotePalette
        api={api}
        docs={docs}
        currentId={current?.id}
        open={picking}
        loading={listing}
        error={listError}
        revision={revision}
        onClose={() => {
          setPicking(false);
          requestAnimationFrame(() => area.current?.focus());
        }}
        onSelect={switchTo}
      />
      <dialog ref={help} aria-label="ショートカット">
        <h2>ショートカット</h2>
        <ul>
          {shortcutHelp.map(([keys, label]) => (
            <li key={keys}>
              <kbd>{keys}</kbd> {label}
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => help.current?.close()}>
          閉じる
        </button>
      </dialog>
    </>
  );
}
