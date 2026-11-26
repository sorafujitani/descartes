import { useCallback, useRef, type RefObject } from "react";
import type { client, Document } from "@descartes/shared";

/**
 * A note read while it is highlighted in the switcher opens without a round trip. It is used only
 * briefly: an older copy could be outdated, and saving it would then report a conflict.
 */
const PREFETCH_TTL = 10_000;

export function usePrefetch(
  api: ReturnType<typeof client>,
  currentRef: RefObject<Document | undefined>,
) {
  const prefetched = useRef(new Map<string, { at: number; doc: Promise<Document> }>());
  const prefetch = useCallback(
    (id: string) => {
      const hit = prefetched.current.get(id);
      if (id === currentRef.current?.id || (hit && Date.now() - hit.at < PREFETCH_TTL)) return;
      const doc = api.get(id);
      const entry = { at: Date.now(), doc };
      doc.catch(() => {
        if (prefetched.current.get(id) === entry) prefetched.current.delete(id);
      });
      prefetched.current.set(id, entry);
    },
    [api],
  );
  /** Opens a note, from a fresh prefetched copy when there is one. */
  const load = (id: string) => {
    const hit = prefetched.current.get(id);
    prefetched.current.clear();
    return hit && Date.now() - hit.at < PREFETCH_TTL ? hit.doc : api.get(id);
  };
  /** A saved note has a new SHA, so its prefetched copy is outdated. */
  const forget = (id: string) => {
    prefetched.current.delete(id);
  };
  return { prefetch, load, forget };
}
