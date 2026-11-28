import { useEffect, useRef, type RefObject } from "react";
import type { EditCommand, NoteViewHandle } from "./NoteView";

const actions: { command: EditCommand; label: string; path: string }[] = [
  { command: "outdent", label: "インデントを戻す", path: "M10 4L6 8l4 4M3 3v10" },
  { command: "indent", label: "インデント", path: "M6 4l4 4-4 4M13 3v10" },
];

/**
 * Touch keyboards have no Tab key, so list items get nesting buttons in a full-width bar directly
 * above the keyboard (iOS's own ^ v ✓ row cannot be extended by a web page). CSS shows the bar
 * only on touch devices with the editor focused.
 */
export function EditToolbar({
  editor,
  disabled,
}: {
  editor: RefObject<NoteViewHandle | null>;
  disabled?: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // `position: fixed` ignores the on-screen keyboard; follow the visible viewport instead.
    const viewport = window.visualViewport;
    if (!viewport) return;
    const place = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      bar.current?.style.setProperty("--keyboard-inset", `${Math.max(0, covered)}px`);
    };
    // iOS reports intermediate sizes while the keyboard slides in, and may not send a final
    // event; keep measuring for the length of the animation after anything that moves it.
    let frame = 0;
    let until = 0;
    const follow = () => {
      place();
      frame = performance.now() < until ? requestAnimationFrame(follow) : 0;
    };
    const settle = () => {
      until = performance.now() + 800;
      if (!frame) frame = requestAnimationFrame(follow);
    };
    place();
    viewport.addEventListener("resize", settle);
    viewport.addEventListener("scroll", settle);
    document.addEventListener("focusin", settle);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", settle);
      viewport.removeEventListener("scroll", settle);
      document.removeEventListener("focusin", settle);
    };
  }, []);
  return (
    <div ref={bar} className="edit-toolbar" role="toolbar" aria-label="編集">
      {actions.map(({ command, label, path }) => (
        <button
          key={command}
          type="button"
          className="icon"
          aria-label={label}
          title={label}
          disabled={disabled}
          // Keep the editor focused, so the keyboard stays open and the caret stays put.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => editor.current?.command(command)}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ))}
    </div>
  );
}
