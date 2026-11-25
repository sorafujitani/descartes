import {
  memo,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  messageOf,
  normalizeSearch,
  searchTerms,
  type client,
  type SearchResult,
  type Summary,
} from "@descartes/shared";

const recentKey = "recentNotes";
/** Notes opened most recently, newest first (ids only; titles come from the list). */
export function recentNotes(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey) ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}
export function rememberNote(id: string) {
  try {
    localStorage.setItem(
      recentKey,
      JSON.stringify([id, ...recentNotes().filter((other) => other !== id)].slice(0, 12)),
    );
  } catch {
    /* Storage may be unavailable (private mode); recents are only a convenience. */
  }
}

type Row = Summary & { snippet?: string };
type Props = {
  api: ReturnType<typeof client>;
  docs: Summary[];
  currentId?: string;
  open: boolean;
  error: string;
  loading: boolean;
  revision?: number;
  onClose: () => void;
  onSelect: (id?: string) => void;
};
/**
 * The note switcher (⌘P): a search field over the notes, recently opened ones first, with an
 * optional full-text search. Keyboard: type to filter, ↑↓ to choose, Return to open, Esc to close.
 */
export const NotePalette = memo(function NotePalette({
  api,
  docs,
  currentId,
  open,
  error,
  loading,
  revision = 0,
  onClose,
  onSelect,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [fullText, setFullText] = useState(false);
  const [matches, setMatches] = useState<SearchResult[]>([]);
  const [searchDone, setSearchDone] = useState(true);
  const [searchError, setSearchError] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const deferred = useDeferredValue(query);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setQuery("");
      setActive(0);
      setRecent(recentNotes());
      element.showModal?.();
      requestAnimationFrame(() => field.current?.focus());
    } else if (!open && element.open) element.close();
  }, [open]);
  const indexed = useMemo(
    () => docs.map((doc) => ({ doc, text: normalizeSearch(doc.title) })),
    [docs],
  );
  const sections = useMemo((): { label: string; rows: Row[] }[] => {
    if (fullText && deferred.trim()) return [{ label: "", rows: matches }];
    const terms = searchTerms(deferred);
    const found = indexed
      .filter(({ text }) => terms.every((term) => text.includes(term)))
      .map(({ doc }) => doc);
    const byId = new Map(found.map((doc) => [doc.id, doc]));
    const recents = recent.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const rest = found.filter((doc) => !recents.includes(doc));
    if (terms.length) return [{ label: "", rows: [...recents, ...rest] }];
    return [
      { label: "最近", rows: recents },
      { label: "すべてのノート", rows: rest },
    ].filter((section) => section.rows.length);
  }, [indexed, deferred, fullText, matches, recent]);
  const rows = sections.flatMap((section) => section.rows);
  useEffect(() => setActive(0), [deferred, fullText]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    setMatches([]);
    setSearchError("");
    if (!fullText || !query.trim()) {
      setSearchDone(true);
      return;
    }
    const controller = new AbortController();
    setSearchDone(false);
    const timer = setTimeout(async () => {
      try {
        const result = await api.search(query, controller.signal, (items) => {
          if (!controller.signal.aborted) setMatches(items);
        });
        if (!controller.signal.aborted) setMatches(result.items);
      } catch (error) {
        if (!controller.signal.aborted) setSearchError(messageOf(error));
      } finally {
        if (!controller.signal.aborted) setSearchDone(true);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, fullText, revision]);
  const choose = (id?: string) => {
    onSelect(id);
    onClose();
  };
  let index = -1;
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="ノート一覧"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="palette-search">
        <input
          ref={field}
          type="search"
          aria-label={fullText ? "本文も検索" : "ノートを検索"}
          placeholder={fullText ? "本文も検索…" : "ノートを検索…"}
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((value) => Math.max(0, Math.min(rows.length - 1, value + step)));
            } else if (event.key === "Escape") {
              // Escape in the search field closes the switcher (not just clears the field).
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter" && rows[active]) {
              event.preventDefault();
              choose(rows[active].id);
            }
          }}
        />
        <label className="palette-mode">
          <input
            type="checkbox"
            checked={fullText}
            onChange={(event) => setFullText(event.target.checked)}
          />
          本文も検索
        </label>
      </div>
      <ul ref={list} className="palette-list" aria-label="ノート">
        {sections.map((section) => (
          <li key={section.label || "results"}>
            {section.label && <small className="palette-section">{section.label}</small>}
            <ul>
              {section.rows.map((doc) => {
                index++;
                const at = index;
                return (
                  <li key={doc.id}>
                    <button
                      type="button"
                      data-index={at}
                      className={at === active ? "active" : undefined}
                      aria-current={currentId === doc.id ? "page" : undefined}
                      onMouseMove={() => setActive(at)}
                      onClick={() => choose(doc.id)}
                    >
                      <span className="palette-title">{doc.title || "無題"}</span>
                      {doc.snippet && <small className="search-snippet">{doc.snippet}</small>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {(searchError || error) && <p role="alert">{searchError || error}</p>}
      {!rows.length && !loading && searchDone && !searchError && !error && (
        <p className="palette-empty">
          {query.trim() ? "見つかりません" : "ノートはまだありません"}
        </p>
      )}
      <div className="palette-footer">
        <button type="button" onClick={() => choose()}>
          ＋ 新規ノート <kbd>⌘N</kbd>
        </button>
        <small>↑↓ で選択 · Return で開く · Esc で閉じる</small>
      </div>
    </dialog>
  );
});
