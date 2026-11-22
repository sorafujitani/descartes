import { memo, useDeferredValue, useEffect, useMemo, useState, type RefObject } from "react";
import {
  messageOf,
  normalizeSearch,
  searchTerms,
  type client,
  type SearchResult,
  type Summary,
} from "@descartes/shared";

type Props = {
  api: ReturnType<typeof client>;
  docs: Summary[];
  currentId?: string;
  busy: boolean;
  loading: boolean;
  error: string;
  revision?: number;
  searchRef: RefObject<HTMLInputElement | null>;
  onSelect: (id?: string) => void;
};
export const DocumentList = memo(function DocumentList({
  api,
  docs,
  currentId,
  busy,
  loading,
  error,
  revision = 0,
  searchRef,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const [fullText, setFullText] = useState(false);
  const [matches, setMatches] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [limit, setLimit] = useState(100);
  const deferred = useDeferredValue(query);
  const indexed = useMemo(
    () => docs.map((doc) => ({ doc, text: normalizeSearch(doc.title) })),
    [docs],
  );
  const rows = useMemo(() => {
    if (fullText && deferred.trim()) return matches;
    const terms = searchTerms(deferred);
    return indexed
      .filter(({ text }) => terms.every((term) => text.includes(term)))
      .map(({ doc }) => doc);
  }, [indexed, deferred, fullText, matches]);
  useEffect(() => {
    setLimit(100);
    setMatches([]);
    setSearchError("");
    if (!fullText || !query.trim()) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.search(query, controller.signal, (items) => {
          if (!controller.signal.aborted) setMatches(items);
        });
        if (!controller.signal.aborted) setMatches(result.items);
      } catch (error) {
        if (!controller.signal.aborted) setSearchError(messageOf(error));
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, fullText, revision]);
  return (
    <aside aria-label="文書一覧">
      <div className="bar">
        <h2>文書</h2>
        <button disabled={busy} onClick={() => onSelect()}>
          新規作成
        </button>
      </div>
      <input
        ref={searchRef}
        type="search"
        aria-label={fullText ? "本文も検索" : "タイトルで検索"}
        placeholder={fullText ? "本文も検索" : "タイトルで検索"}
        value={query}
        maxLength={200}
        onChange={(event) => setQuery(event.target.value)}
      />
      <label className="search-mode">
        <input
          type="checkbox"
          checked={fullText}
          onChange={(event) => setFullText(event.target.checked)}
        />
        本文も検索
      </label>
      {(loading || searching) && (
        <small role="status">{searching ? "検索しています…" : "文書一覧を読み込み中…"}</small>
      )}
      <ul>
        {rows.slice(0, limit).map((doc) => (
          <li key={doc.id}>
            <button
              aria-current={currentId === doc.id ? "page" : undefined}
              disabled={busy}
              onClick={() => onSelect(doc.id)}
            >
              {doc.title}
              {"snippet" in doc && <small className="search-snippet">{String(doc.snippet)}</small>}
            </button>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button onClick={() => setLimit((value) => value + 100)}>さらに表示</button>
      )}
      {(searchError || error) && <p role="alert">{searchError || error}</p>}
      {!loading && !searching && !error && !searchError && !rows.length && (
        <small>該当する文書はありません。</small>
      )}
    </aside>
  );
});
