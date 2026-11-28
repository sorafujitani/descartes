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
    const element = bar.current;
    if (!viewport || !element) return;
    const covered = () =>
      Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    // iOS moves the visible viewport while scrolling and while the keyboard slides in, and
    // reports it a frame late, so a bar that follows it shakes. Hide it while the viewport moves
    // and show it again once the position has been stable for a moment.
    let frame = 0;
    let lastEvent = 0;
    let stableSince = 0;
    let value = -1;
    const tick = () => {
      const now = performance.now();
      const next = covered();
      if (next !== value) {
        value = next;
        stableSince = now;
        element.style.setProperty("--keyboard-inset", `${next}px`);
      }
      if (now - lastEvent > 200 && now - stableSince > 200) {
        element.removeAttribute("data-moving");
        frame = 0;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const settle = () => {
      lastEvent = performance.now();
      element.setAttribute("data-moving", "");
      if (!frame) frame = requestAnimationFrame(tick);
    };
    settle();
    viewport.addEventListener("resize", settle);
    viewport.addEventListener("scroll", settle);
    window.addEventListener("scroll", settle, { passive: true });
    document.addEventListener("focusin", settle);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", settle);
      viewport.removeEventListener("scroll", settle);
      window.removeEventListener("scroll", settle);
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
