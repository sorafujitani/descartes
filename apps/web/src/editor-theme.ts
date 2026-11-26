import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const proseHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.8em", fontWeight: "700", color: "var(--color-text)" },
  { tag: tags.heading2, fontSize: "1.45em", fontWeight: "650", color: "var(--color-text)" },
  {
    tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    fontSize: "1.2em",
    fontWeight: "650",
  },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--color-accent)" },
  { tag: tags.monospace, fontFamily: "var(--font-code)", color: "var(--color-code-text)" },
  // Markdown syntax (list numbers, quote and emphasis marks) in the body font, quieter.
  { tag: tags.processingInstruction, color: "var(--color-text-muted)" },
  { tag: tags.meta, color: "var(--color-text-muted)" },
]);
/** Hanging indents per indentation (CSP forbids inline styles, so these are classes). */
const hangingIndents: Record<string, { paddingLeft: string; textIndent: string }> = {};
/** Each nesting level steps in by about one marker width, so levels are easy to tell apart. */
const nestingStep = "1.5rem";
export const maxDepth = 8;
for (const [kind, width] of [
  ["b", "1.45rem"],
  ["o2", "1.95rem"],
  ["o3", "2.45rem"],
] as const)
  for (let depth = 0; depth <= maxDepth; depth++)
    // ".cm-line." outranks the theme's own ".cm-line" padding. The first line starts at the
    // depth's indent with the marker; wrapped lines start after the marker.
    hangingIndents[`.cm-line.cm-hang-${kind}-${depth}`] = {
      paddingLeft: `calc(${depth} * ${nestingStep} + ${width})`,
      textIndent: `calc(-1 * ${width})`,
    };
export const noteTheme = EditorView.theme(
  {
    ...hangingIndents,
    "&": { backgroundColor: "transparent", color: "var(--color-text)", fontSize: "1rem" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.6", overflow: "visible" },
    ".cm-content": { padding: "0.5rem 0 1rem", minHeight: "16rem", overflowWrap: "anywhere" },
    ".cm-line": { padding: "2px 0" },
    ".cm-cursor": { borderLeftColor: "var(--color-text)", transform: "scaleY(0.8)" },
    // Selection is translucent and drawn behind the text, so selected text stays readable. The
    // focused selector matches CodeMirror's own (more specific) one, which otherwise wins with an
    // opaque light-theme lavender.
    ".cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      { background: "color-mix(in srgb, var(--color-accent) 28%, transparent)" },
    ".cm-line::selection, .cm-line ::selection, .cm-content ::selection": {
      backgroundColor: "transparent",
    },
    // Checkboxes and bullets match the Mac app: a muted outlined box, a dot centred in the same
    // space, and item text starting at the same position for both.
    // Marker boxes are 1.45rem wide (the hanging indent): 0.1rem + 0.9rem mark + 0.45rem gap.
    // text-indent is reset: the line's negative hanging indent would otherwise move the box.
    ".cm-task-box": {
      display: "inline-block",
      width: "1.45rem",
      textIndent: "0",
      whiteSpace: "nowrap",
    },
    ".cm-task-checkbox": {
      appearance: "none",
      position: "relative",
      boxSizing: "border-box",
      width: "0.9rem",
      height: "0.9rem",
      padding: "0",
      margin: "0 0 0.15em 0.1rem",
      border: "1.5px solid var(--color-text-muted)",
      borderRadius: "0.22rem",
      backgroundColor: "transparent",
      verticalAlign: "middle",
      cursor: "pointer",
    },
    ".cm-task-checkbox:checked::after": {
      content: '""',
      position: "absolute",
      left: "0.24rem",
      top: "0.06rem",
      width: "0.22rem",
      height: "0.45rem",
      border: "solid var(--color-text-muted)",
      borderWidth: "0 1.5px 1.5px 0",
      transform: "rotate(45deg)",
    },
    ".cm-task-checkbox:focus-visible": {
      outline: "2px solid var(--color-accent)",
      outlineOffset: "2px",
    },
    ".cm-bullet": {
      position: "relative",
      display: "inline-block",
      width: "1.45rem",
      height: "0.9rem",
      margin: "0 0 0.15em 0",
      verticalAlign: "middle",
    },
    ".cm-bullet::before": {
      content: '""',
      position: "absolute",
      left: "0.4rem",
      top: "calc(50% - 0.15rem)",
      width: "0.3rem",
      height: "0.3rem",
      borderRadius: "50%",
      backgroundColor: "var(--color-text-muted)",
    },
    ".cm-code-line": {
      backgroundColor: "var(--color-code-bg)",
      padding: "0 1rem",
      fontFamily: "var(--font-code)",
    },
    ".cm-code-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px" },
    ".cm-code-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px" },
    ".cm-code-fence": { color: "var(--color-text-muted)", fontSize: "0.85em" },
    ".cm-fence-hidden": { fontSize: "0", lineHeight: "0.75rem", padding: "0 1rem" },
    ".cm-quote": { color: "var(--color-text-muted)" },
    ".cm-title-placeholder": {
      color: "var(--color-text-muted)",
      opacity: "0.6",
      pointerEvents: "none",
    },
    ".cm-ordered": { display: "inline-block", textIndent: "0", whiteSpace: "pre" },
    ".cm-ordered-1": { width: "1.45rem" },
    ".cm-ordered-2": { width: "1.95rem" },
    ".cm-ordered-3": { width: "2.45rem" },
    ".cm-inline-code": {
      padding: "0.1em 0.3em",
      borderRadius: "4px",
      backgroundColor: "var(--color-code-bg)",
      fontSize: "0.9em",
    },
    ".cm-link-label": { color: "var(--color-accent)", textDecoration: "underline" },
    ".cm-table": { fontFamily: "var(--font-code)", fontSize: "0.9em" },
    ".cm-rule": {
      backgroundImage:
        "linear-gradient(var(--color-border, #2d333b), var(--color-border, #2d333b))",
      backgroundSize: "100% 1px",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    },
    ".cm-quote-bar": {
      display: "inline-block",
      width: "3px",
      height: "1.2em",
      margin: "0 calc(1.35rem - 3px) -0.2em 0.1rem",
      borderRadius: "2px",
      backgroundColor: "var(--color-border, #2d333b)",
      verticalAlign: "baseline",
    },
    ".cm-completed-task": { color: "var(--color-text-muted)", textDecoration: "line-through" },
    ".cm-note-image": { maxWidth: "min(100%, 320px)", maxHeight: "240px", verticalAlign: "middle" },
  },
  { dark: true },
);
