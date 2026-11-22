import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf, type client, type Summary } from "@descartes/shared";

export function useDocuments(api: ReturnType<typeof client>) {
  const [docs, setDocs] = useState<Summary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const local = useRef(new Map<string, Summary>());
  const upsert = useCallback((doc: Summary) => {
    local.current.set(doc.id, { id: doc.id, title: doc.title });
    setRevision((value) => value + 1);
    setDocs((rows) =>
      [...rows.filter((row) => row.id !== doc.id), { id: doc.id, title: doc.title }].sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
    );
  }, []);
  useEffect(() => {
    let controller: AbortController;
    async function refresh() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      local.current.clear();
      setLoading(true);
      setError("");
      const collected = new Map<string, Summary>();
      try {
        for await (const page of api.pages(request.signal)) {
          if (request.signal.aborted) return;
          for (const doc of page) collected.set(doc.id, doc);
          // A save completing during a slow refresh must win over its old title page.
          const merged = new Map([...collected, ...local.current]);
          setDocs([...merged.values()].sort((a, b) => a.title.localeCompare(b.title)));
        }
        if (!request.signal.aborted) setRevision((value) => value + 1);
      } catch (error) {
        if (!request.signal.aborted) setError(messageOf(error));
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    }
    void refresh();
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller?.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api]);
  return { docs, loading, error, revision, upsert };
}
