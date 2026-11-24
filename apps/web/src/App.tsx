import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { DocumentList } from "./DocumentList";
import { NoteView, type NoteViewHandle } from "./NoteView";
const Markdown = lazy(() => import("./Markdown").then((module) => ({ default: module.Markdown })));
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
  toggleTaskAt,
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
  initialId = defaultId,
}: {
  api?: ReturnType<typeof client>;
  initialId?: string | null;
}) {
  const { docs, loading: listing, error: listError, revision, upsert } = useDocuments(api);
  const [current, setCurrent] = useState<Document>(),
    [text, setText] = useState(blank),
    [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(Boolean(initialId)),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const operation = useRef(Boolean(initialId));
  const latestText = useRef(text);
  latestText.current = text;
  /** Incremented whenever another document is shown, so late save responses cannot apply to it. */
  const session = useRef(0);
  /** A conflict stops autosave until an explicit save succeeds or another document is opened. */
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const upload = useRef<HTMLInputElement>(null);
  const area = useRef<NoteViewHandle>(null);
  const [noteSession, setNoteSession] = useState(0);
  const search = useRef<HTMLInputElement>(null);
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
        setCurrent(doc);
        setText(doc.markdown);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(messageOf(error));
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
    setNotice("");
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
    setPreview(false);
    currentRef.current = doc;
    latestText.current = doc?.markdown ?? blank;
    session.current++;
    pausedRef.current = false;
    setPaused(false);
    setNoteSession((session) => session + 1);
    setCurrent(doc);
    setText(doc?.markdown ?? blank);
    setEditing(!doc);
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
  /** Explicit save (⌘S / 保存). It also retries after a conflict or a failed autosave. */
  async function save() {
    if (operation.current || !unsaved()) return;
    if (!titleOf(latestText.current)) {
      setError(untitled);
      return;
    }
    pausedRef.current = false;
    setPaused(false);
    if (!(await flush())) return;
    if (latestText.current === currentRef.current?.markdown) setEditing(false);
    setNotice(unsaved() ? "保存しました。続きの変更は未保存です。" : "保存しました。");
  }
  async function attach(file?: File) {
    if (!file) return;
    await run(async () => {
      if (file.size > 4 * 1024 * 1024) throw new Error("画像は4 MiB以下にしてください。");
      const { path } = await api.attach(file);
      setText((t) => t + "\n\n![スクリーンショット](" + path + ")\n");
      setNotice("画像を追加しました。");
    });
  }
  const [preview, setPreview] = useState(false);
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
    setSaving(true);
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
          setPaused(true);
        } else schedule(autosaveTiming.retry);
        return false;
      } finally {
        writing.current = null;
        setSaving(false);
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
    setNotice("");
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
      if (preview) {
        const heads = [...document.querySelectorAll(".sora-prose :is(h1, h2, h3, h4, h5, h6)")];
        const current = heads.findIndex((node) => node.getBoundingClientRect().top >= 80);
        const node = heads[forward ? Math.max(current, 0) : current - 1];
        node?.scrollIntoView({ block: "center" });
        return;
      }
      const field = area.current;
      if (!field) return;
      const caret = headingCaret(field.value, field.selectionStart, forward);
      if (caret === undefined) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    }
    function find(forward: boolean) {
      const field = area.current;
      if (preview || !field) {
        const page = window as Window & {
          find?: (
            query: string,
            caseSensitive: boolean,
            backwards: boolean,
            wrap: boolean,
          ) => boolean;
        };
        page.find?.(query, false, !forward, true);
        return;
      }
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
      const typingSearch = target === search.current;
      const typingFind = target === finder.current;
      if (target instanceof Element && target.closest(".note") && !event.metaKey && !event.ctrlKey)
        return;
      if (typingSearch && !event.metaKey && !event.ctrlKey) return;
      if (typingFind && action === "continue") {
        event.preventDefault();
        find(true);
        return;
      }
      if (
        (typingSearch || typingFind) &&
        (action === "continue" || action === "indent" || action === "outdent")
      )
        return;
      const field = area.current;
      const span = { start: field?.selectionStart ?? 0, end: field?.selectionEnd ?? 0 };
      const body = field?.value ?? text;
      if (action === "new") {
        event.preventDefault();
        setPreview(false);
        switchTo();
      } else if (action === "save") {
        event.preventDefault();
        void save();
      } else if (action === "search") {
        event.preventDefault();
        search.current?.focus();
      } else if (action === "preview") {
        event.preventDefault();
        setPreview((value) => !value);
        if (preview) requestAnimationFrame(() => area.current?.focus());
      } else if (action === "help") {
        event.preventDefault();
        help.current?.showModal();
      } else if (action === "edit") {
        event.preventDefault();
        if (preview) {
          setPreview(false);
          requestAnimationFrame(() => area.current?.focus());
        } else if (field) edit(wrapSelection(body, span, "`"));
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
      } else if (!field || preview) {
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
      } else if (action === "bold" || action === "italic" || action === "code") {
        event.preventDefault();
        edit(wrapSelection(body, span, action === "bold" ? "**" : action === "italic" ? "*" : "`"));
      } else if (action === "link") {
        event.preventDefault();
        edit(insertLink(body, span));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, current, editing, preview, query, save, switchTo, text]);
  const status = busy
    ? "読み書きしています…"
    : saving
      ? "保存しています…"
      : notice ||
        (!dirty
          ? ""
          : paused
            ? "自動保存を停止しています。内容を控えてから開き直すか、⌘S で再試行してください。"
            : !titleOf(text)
              ? "1行目に「# タイトル」を書くと自動保存します。"
              : "未保存の変更があります（自動保存します）。");
  return (
    <>
      <header>
        <b>Descartes</b>
        <button type="button" onClick={() => help.current?.showModal()}>
          ショートカット
        </button>
      </header>
      <main>
        <DocumentList
          api={api}
          docs={docs}
          currentId={current?.id}
          busy={busy}
          loading={listing}
          error={listError}
          revision={revision}
          searchRef={search}
          onSelect={switchTo}
        />
        <section aria-label="文書">
          <div role="status">{status}</div>
          {error && <p role="alert">{error}</p>}
          {editing || current ? (
            <>
              <div className="bar">
                <button disabled={busy} onClick={() => upload.current?.click()}>
                  画像を添付
                </button>
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
                <button
                  disabled={busy || !dirty}
                  title="自動保存されます。今すぐ保存するときは ⌘S"
                  onClick={() => void save()}
                >
                  保存
                </button>
                <button disabled={busy} onClick={() => setPreview((value) => !value)}>
                  {preview ? "本文に戻る" : "プレビュー"}
                </button>
                {dirty && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (confirm("変更を破棄しますか？")) setText(current?.markdown ?? blank);
                    }}
                  >
                    元に戻す
                  </button>
                )}
              </div>
              <div className="sheet" style={{ "--note-zoom": zoom / 10 } as CSSProperties}>
                <div hidden={preview}>
                  <NoteView
                    key={noteSession}
                    ref={area}
                    markdown={text}
                    onChange={updateNote}
                    readOnly={busy}
                    focusAt={editing && !current ? 2 : null}
                  />
                </div>
                {preview && (
                  <Suspense fallback={<p role="status">表示を準備しています…</p>}>
                    <Markdown
                      source={text}
                      documentKey={String(noteSession)}
                      onToggleTask={(index) => {
                        const next = toggleTaskAt(latestText.current, index);
                        if (next !== undefined) updateNote(next, true);
                      }}
                    />
                  </Suspense>
                )}
              </div>
              {finding && (
                <input
                  ref={finder}
                  type="search"
                  aria-label="本文検索"
                  placeholder="本文を検索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
            </>
          ) : (
            <p>文書を選ぶか、新規作成してください。</p>
          )}
        </section>
      </main>
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
