import { useEffect, useRef, type RefObject } from "react";
import type { EditCommand, NoteViewHandle } from "./NoteView";

const actions: { command: EditCommand; label: string; path: string }[] = [
  { command: "outdent", label: "インデントを戻す", path: "M10 4L6 8l4 4M3 3v10" },
  { command: "indent", label: "インデント", path: "M6 4l4 4-4 4M13 3v10" },
];

/**
 * Touch keyboards have no Tab key, so list items get nesting buttons above the keyboard while the
 * note is being edited (CSS shows the bar only on touch devices with the editor focused).
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
    place();
    viewport.addEventListener("resize", place);
    viewport.addEventListener("scroll", place);
    return () => {
      viewport.removeEventListener("resize", place);
      viewport.removeEventListener("scroll", place);
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
