import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { messageOf, titleOf, ApiError, type client, type Document } from "@descartes/shared";
import { rememberNote } from "./NotePalette";

/** The text of a new, empty note. */
export const blank = "# ";
/**
 * Autosave waits for a pause in typing, but never leaves continuous typing unsaved for longer than
 * the maximum delay. Every save is a Git commit, and GitHub limits content-creating requests
 * (roughly 80 per minute and 500 per hour), so saves are coalesced instead of sent per keystroke.
 */
export const autosaveTiming = { idle: 4_000, max: 45_000, retry: 30_000 };
const untitled = "1行目に「# タイトル」を入力してください。";

/**
 * Saving the open note: the autosave timers, explicit ⌘S saves, and saves when the page is left.
 * The caller owns the text and the shown document; this hook reads them through refs so that
 * saves started by an earlier render still see the newest values.
 */
export function useAutosave({
  api,
  upsert,
  text,
  dirty,
  latestText,
  currentRef,
  operation,
  setCurrent,
  setError,
  onSaved,
}: {
  api: ReturnType<typeof client>;
  upsert: (doc: Document) => void;
  text: string;
  dirty: boolean;
  latestText: RefObject<string>;
  currentRef: RefObject<Document | undefined>;
  /** Set while a blocking operation (loading, switching, uploading) runs; autosave waits. */
  operation: RefObject<boolean>;
  setCurrent: Dispatch<SetStateAction<Document | undefined>>;
  setError: Dispatch<SetStateAction<string>>;
  /** Called for every acknowledged save, also when another document is shown by then. */
  onSaved: (doc: Document) => void;
}) {
  /** Incremented whenever another document is shown, so late save responses cannot apply to it. */
  const session = useRef(0);
  /** A conflict stops autosave until an explicit save succeeds or another document is opened. */
  const pausedRef = useRef(false);
  const writing = useRef<{ draft: string; again: boolean; promise: Promise<boolean> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dirtySince = useRef<number | null>(null);
  const unsaved = () => latestText.current !== (currentRef.current?.markdown ?? blank);
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
          onSaved(doc);
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
  /** Another document is shown: drop late responses for the old one and resume autosave. */
  function startSession() {
    session.current++;
    pausedRef.current = false;
  }
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
  return { flush, save, unsaved, startSession };
}
