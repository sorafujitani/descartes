/**
 * The note editor embedded in the Mac app (WKWebView). It is the same CodeMirror NoteView as the
 * web app, so editing behaves identically on both. The page talks to Swift through
 * `window.webkit.messageHandlers.descartes` and exposes `window.descartes` for Swift to call.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { caretBelowTitle, findMatch } from "@descartes/shared";
import { NoteView, type EditCommand, type NoteViewHandle } from "./NoteView";
import "@sorafujitani/document-design-system/tokens.css";
import "@sorafujitani/document-design-system/theme.css";
import "./style.css";
import "./editor.css";

type Message =
  | { type: "ready" }
  | { type: "change"; markdown: string; persist: boolean }
  | { type: "found"; found: boolean };
export type EditorBridge = {
  /**
   * Shows another note (or a reloaded one): a fresh editor with its own undo history. Without
   * `caret`, the caret starts on the line below the title.
   */
  load(markdown: string, caret?: number): void;
  configure(options: { readOnly?: boolean; raw?: boolean; zoom?: number }): void;
  command(name: EditCommand): boolean;
  find(action: "show" | "next" | "previous"): void;
  focus(): void;
  /** For tests and automation. */
  text(): string;
  select(start: number, end: number): void;
};
declare global {
  interface Window {
    descartes?: EditorBridge;
    webkit?: { messageHandlers?: { descartes?: { postMessage(message: Message): void } } };
  }
}
const post = (message: Message) => window.webkit?.messageHandlers?.descartes?.postMessage(message);

function EditorApp() {
  const [note, setNote] = useState({ markdown: "# ", key: 0, caret: 2 });
  const [options, setOptions] = useState({ readOnly: false, raw: false });
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [missing, setMissing] = useState(false);
  const editor = useRef<NoteViewHandle>(null);
  const finder = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  function find(forward: boolean) {
    const field = editor.current;
    if (!field) return;
    const match = findMatch(
      field.value,
      queryRef.current,
      forward ? field.selectionEnd : field.selectionStart,
      forward,
    );
    setMissing(Boolean(queryRef.current) && !match);
    if (match) field.setSelectionRange(match.start, match.end);
    post({ type: "found", found: Boolean(match) });
  }
  const findRef = useRef(find);
  findRef.current = find;
  useEffect(() => {
    window.descartes = {
      load(markdown, caret) {
        setNote((current) => ({
          markdown,
          key: current.key + 1,
          caret: caret ?? caretBelowTitle(markdown),
        }));
      },
      configure({ readOnly, raw, zoom }) {
        setOptions((current) => ({
          readOnly: readOnly ?? current.readOnly,
          raw: raw ?? current.raw,
        }));
        if (zoom) document.documentElement.style.fontSize = (15 * zoom) / 10 + "px";
      },
      command: (name) => editor.current?.command(name) ?? false,
      find(action) {
        if (action === "show") {
          setFinding(true);
          requestAnimationFrame(() => finder.current?.select());
        } else findRef.current(action === "next");
      },
      focus: () => editor.current?.focus(),
      text: () => editor.current?.value ?? "",
      select: (start, end) => editor.current?.setSelectionRange(start, end),
    };
    post({ type: "ready" });
  }, []);
  return (
    <>
      {finding && (
        <div className="find-bar" role="search">
          <input
            ref={finder}
            aria-label="本文内を検索"
            placeholder="本文内を検索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                find(!event.shiftKey);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setFinding(false);
                editor.current?.focus();
              }
            }}
          />
          <small>{missing ? "見つかりません" : "Return：次 · ⇧Return：前 · Esc：閉じる"}</small>
        </div>
      )}
      <div className="embedded-note">
        <NoteView
          key={note.key}
          ref={editor}
          markdown={note.markdown}
          focusAt={note.caret}
          readOnly={options.readOnly}
          raw={options.raw}
          assetUrl={(name) => "asset/" + name}
          onChange={(markdown, persist) => post({ type: "change", markdown, persist: !!persist })}
        />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<EditorApp />);
