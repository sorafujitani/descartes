import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { NotePalette, recentNotes, rememberNote } from "./NotePalette";
import { NoteView, type NoteViewHandle } from "./NoteView";
import { EditToolbar } from "./EditToolbar";
import { useAutosave, blank } from "./useAutosave";
import { useDocuments } from "./useDocuments";
import { usePrefetch } from "./usePrefetch";
import { useShortcuts } from "./useShortcuts";
import {
  client,
  messageOf,
  shortcutHelp,
  titleOf,
  type Document,
  type Span,
} from "@descartes/shared";
export { autosaveTiming } from "./useAutosave";
const defaultId = new URLSearchParams(location.search).get("doc");
const defaultApi = client(location.origin);
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
  const currentRef = useRef(current);
  currentRef.current = current;
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
  const { prefetch, load, forget } = usePrefetch(api, currentRef);
  const { flush, save, unsaved, startSession } = useAutosave({
    api,
    upsert,
    text,
    dirty,
    latestText,
    currentRef,
    operation,
    setCurrent,
    setError,
    onSaved: (doc) => forget(doc.id),
  });
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
    startSession();
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
  const switchTo = useCallback(
    (id?: string) => {
      if (operation.current) return;
      void run(async () => {
        // Save before leaving; ask only when the latest text could not be saved.
        await flush();
        if (unsaved() && !confirm("保存できなかった変更を破棄しますか？")) return;
        select(id ? await load(id) : undefined);
      });
    },
    [run, select],
  );
  async function attach(file?: File) {
    if (!file) return;
    await run(async () => {
      if (file.size > 4 * 1024 * 1024) throw new Error("画像は4 MiB以下にしてください。");
      const { path } = await api.attach(file);
      setText((t) => t + "\n\n![スクリーンショット](" + path + ")\n");
    });
  }
  function updateNote(next: string, persist = false) {
    latestText.current = next;
    setText(next);
    if (!persist) return;
    void flush();
  }
  useEffect(() => localStorage.setItem("noteZoomTenths", String(zoom)), [zoom]);
  useShortcuts({
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
  });
  const closePalette = useCallback(() => {
    setPicking(false);
    requestAnimationFrame(() => area.current?.focus());
  }, []);
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
      <EditToolbar editor={area} disabled={busy} />
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
        onClose={closePalette}
        onSelect={switchTo}
        onPreview={prefetch}
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
