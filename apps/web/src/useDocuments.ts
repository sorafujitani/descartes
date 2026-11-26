import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf, type client, type Summary } from "@descartes/shared";

const cacheKey = "noteList";
/** Returning to the tab refreshes at most this often; opening the app always refreshes. */
const REFRESH_INTERVAL = 30_000;
type Cached = { etag?: string; docs: Summary[] };
const byTitle = (rows: Summary[]) => rows.sort((a, b) => a.title.localeCompare(b.title));

/** The last complete list (titles only), shown at once while the current one loads. */
function readCache(): Cached | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
    if (!Array.isArray(value?.docs)) return undefined;
    const docs = value.docs.filter(
      (doc: unknown): doc is Summary =>
        typeof (doc as Summary)?.id === "string" && typeof (doc as Summary)?.title === "string",
    );
    return { etag: typeof value.etag === "string" ? value.etag : undefined, docs };
  } catch {
    return undefined;
  }
}
function writeCache(value: Cached) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(value));
  } catch {
    /* Storage may be unavailable or full; the cache is only a head start. */
  }
}

export function useDocuments(api: ReturnType<typeof client>) {
  const [initial] = useState(readCache);
  const [docs, setDocs] = useState<Summary[]>(() => initial?.docs ?? []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const local = useRef(new Map<string, Summary>());
  const upsert = useCallback((doc: Summary) => {
    local.current.set(doc.id, { id: doc.id, title: doc.title });
    setRevision((value) => value + 1);
    setDocs((rows) =>
      byTitle([...rows.filter((row) => row.id !== doc.id), { id: doc.id, title: doc.title }]),
    );
  }, []);
  useEffect(() => {
    let controller: AbortController | undefined;
    let cached = initial;
    let refreshedAt = -Infinity;
    async function refresh() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      refreshedAt = Date.now();
      local.current.clear();
      setLoading(true);
      setError("");
      // Only a list whose cache was written by this effect matches the rows on screen.
      const seen = { etag: cached?.etag };
      const collected = new Map<string, Summary>();
      try {
        for await (const page of api.pages(request.signal, seen)) {
          if (request.signal.aborted) return;
          for (const doc of page) collected.set(doc.id, doc);
          // A save completing during a slow refresh must win over its old title page.
          const merged = new Map([...collected, ...local.current]);
          setDocs(byTitle([...merged.values()]));
        }
        if (request.signal.aborted) return;
        if (collected.size || seen.etag !== cached?.etag || !cached) {
          cached = { etag: seen.etag, docs: byTitle([...collected.values()]) };
          writeCache(cached);
        }
        setRevision((value) => value + 1);
      } catch (error) {
        if (!request.signal.aborted) setError(messageOf(error));
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    }
    void refresh();
    const visible = () => {
      if (document.visibilityState === "visible" && Date.now() - refreshedAt >= REFRESH_INTERVAL)
        void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller?.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api]);
  return { docs, loading, error, revision, upsert };
}
