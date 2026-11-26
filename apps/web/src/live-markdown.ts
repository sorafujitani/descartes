import { Facet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { imagePath } from "@descartes/shared";
import { persistTask } from "./editor-commands";
import { maxDepth } from "./editor-theme";

/** Where repository images are loaded from (the Mac app serves them through its own scheme). */
export const assetSource = Facet.define<(name: string) => string, (name: string) => string>({
  combine: (values) => values[0] ?? ((name) => "/api/assets/" + name),
});

class TaskCheckbox extends WidgetType {
  constructor(
    readonly at: number,
    readonly checked: boolean,
    readonly disabled: boolean,
  ) {
    super();
  }
  eq(other: TaskCheckbox) {
    return (
      this.at === other.at && this.checked === other.checked && this.disabled === other.disabled
    );
  }
  updateDOM(dom: HTMLElement) {
    // Only ever reuse a checkbox; reusing another widget's element showed checkboxes on bullets.
    const input = dom.classList.contains("cm-task-box") ? dom.firstElementChild : null;
    if (!(input instanceof HTMLInputElement) || input.type !== "checkbox") return false;
    input.checked = this.checked;
    input.disabled = this.disabled;
    input.dataset.at = String(this.at);
    return true;
  }
  toDOM(view: EditorView) {
    // The box includes the gap before the text, so a caret on an empty todo stands where the
    // text will start (a margin on the input was not counted for the caret).
    const box = document.createElement("span");
    box.className = "cm-task-box";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-task-checkbox";
    input.setAttribute("aria-label", "チェックを切り替える");
    box.append(input);
    this.updateDOM(box);
    input.addEventListener("change", () => {
      if (view.state.readOnly) return;
      const at = Number(input.dataset.at);
      if (!/^\[[ xX]\]$/.test(view.state.doc.sliceString(at - 1, at + 2))) return;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: input.checked ? "x" : " " },
        annotations: persistTask.of(true),
        userEvent: "input.task",
      });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

/** Ordinary "-", "*" and "+" items show a dot, as in the Mac app; the Markdown is unchanged. */
class BulletMark extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof BulletMark;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-bullet";
    dot.setAttribute("aria-hidden", "true");
    return dot;
  }
}
const bullet = Decoration.replace({ atomic: true, widget: new BulletMark() });
class QuoteBar extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof QuoteBar;
  }
  toDOM() {
    const bar = document.createElement("span");
    bar.className = "cm-quote-bar";
    bar.setAttribute("aria-hidden", "true");
    return bar;
  }
}
const quoteBar = Decoration.replace({ atomic: true, widget: new QuoteBar() });
class RepositoryImage extends WidgetType {
  constructor(
    readonly name: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(other: RepositoryImage) {
    return this.name === other.name && this.alt === other.alt;
  }
  toDOM(view: EditorView) {
    const image = document.createElement("img");
    image.src = view.state.facet(assetSource)(this.name);
    image.alt = this.alt;
    image.className = "cm-note-image";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("load", () => view.requestMeasure());
    return image;
  }
  ignoreEvent() {
    return true;
  }
}
/** "タイトル" shown in an empty first line, so a new note asks for its title. */
class TitlePlaceholder extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof TitlePlaceholder;
  }
  toDOM() {
    const hint = document.createElement("span");
    hint.className = "cm-title-placeholder";
    hint.textContent = "タイトル";
    hint.setAttribute("aria-hidden", "true");
    return hint;
  }
}
const titlePlaceholder = Decoration.widget({ widget: new TitlePlaceholder(), side: 1 });
const hiddenMark = Decoration.replace({});
const inlineCode = Decoration.mark({ class: "cm-inline-code" });
const linkLabel = Decoration.mark({ class: "cm-link-label" });
const inlineMarks = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);
function taskDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  /** Whether the caret or a selection touches [from, to] (then its Markdown is shown). */
  const editing = (from: number, to: number) =>
    view.hasFocus &&
    view.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
  const first = view.state.doc.line(1);
  if (/^#[ \t]*$/.test(first.text)) ranges.push(titlePlaceholder.range(first.to));
  for (const visible of view.visibleRanges)
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        // Live preview: inline Markdown (**, *, ~~, `, link syntax) is hidden unless the caret
        // is inside that element, like other note editors. The text itself never changes.
        if (
          node.name === "Emphasis" ||
          node.name === "StrongEmphasis" ||
          node.name === "Strikethrough" ||
          node.name === "InlineCode"
        ) {
          const marks: [number, number][] = [];
          for (let child = node.node.firstChild; child; child = child.nextSibling)
            if (inlineMarks.has(child.name)) marks.push([child.from, child.to]);
          if (node.name === "InlineCode" && marks.length === 2 && marks[0][1] < marks[1][0])
            ranges.push(inlineCode.range(marks[0][1], marks[1][0]));
          if (!editing(node.from, node.to))
            for (const [from, to] of marks) if (to > from) ranges.push(hiddenMark.range(from, to));
        } else if (node.name === "Link") {
          const marks: { name: string; from: number; to: number }[] = [];
          for (let child = node.node.firstChild; child; child = child.nextSibling)
            marks.push({ name: child.name, from: child.from, to: child.to });
          const open = marks.find((mark) => mark.name === "LinkMark");
          const close = marks.filter((mark) => mark.name === "LinkMark")[1];
          const url = marks.find((mark) => mark.name === "URL");
          // Only [label](url) links: the label stays, the brackets and URL hide.
          if (open && close && url && close.from > open.to) {
            ranges.push(linkLabel.range(open.to, close.from));
            if (!editing(node.from, node.to)) {
              ranges.push(hiddenMark.range(open.from, open.to));
              ranges.push(hiddenMark.range(close.from, node.to));
            }
          }
        }
        if (node.name === "Table") {
          // Tables keep their columns aligned in a monospaced font.
          for (
            let line = view.state.doc.lineAt(node.from);
            ;
            line = view.state.doc.line(line.number + 1)
          ) {
            ranges.push(Decoration.line({ class: "cm-table" }).range(line.from));
            if (line.to >= node.to || line.number >= view.state.doc.lines) break;
          }
        }
        if (node.name === "ListMark") {
          // Wrapped item text lines up after its dot, checkbox or number. Nesting is shown by
          // the list depth (a clear step per level), not by the width of the leading spaces.
          const line = view.state.doc.lineAt(node.from);
          let depth = -1;
          for (let parent = node.node.parent; parent; parent = parent.parent)
            if (parent.name === "BulletList" || parent.name === "OrderedList") depth++;
          const indent = Math.max(0, Math.min(maxDepth, depth));
          const leading = view.state.doc.sliceString(line.from, node.from);
          if (leading && /^[ \t]+$/.test(leading))
            ranges.push(Decoration.replace({ atomic: true }).range(line.from, node.from));
          const mark = view.state.doc.sliceString(node.from, node.to);
          const task = /^[ \t]+\[[ xX]\]/.test(view.state.doc.sliceString(node.to, node.to + 5));
          const digits = mark.length - 1;
          const kind =
            task || /^[-*+]$/.test(mark) ? "b" : digits >= 3 ? "o3" : digits === 2 ? "o2" : "b";
          ranges.push(Decoration.line({ class: `cm-hang-${kind}-${indent}` }).range(line.from));
          // Numbers (and their space) sit in a fixed-width box like bullets and checkboxes, so
          // the text and its wrapped lines start at the same place whatever the font.
          if (!task && /^\d/.test(mark) && view.state.doc.sliceString(node.to, node.to + 1) === " ")
            ranges.push(
              Decoration.mark({ class: `cm-ordered cm-ordered-${Math.min(3, digits)}` }).range(
                node.from,
                node.to + 1,
              ),
            );
        }
        if (node.name === "QuoteMark") {
          // The first "> " on a line becomes a quote bar (the Mac app hides it the same way).
          const line = view.state.doc.lineAt(node.from);
          const prefix = view.state.doc.sliceString(line.from, node.from);
          const space = view.state.doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
          // Every quote level ("> > ") becomes its own bar.
          const nested = /^[ \t]*(?:>[ \t]?)*$/.test(prefix);
          if (nested && (space || node.to === line.to)) {
            if (/^[ \t]*$/.test(prefix))
              ranges.push(
                Decoration.line({
                  class: "cm-quote cm-hang-b-0",
                }).range(line.from),
              );
            ranges.push(quoteBar.range(node.from, node.to + space));
          }
        } else if (node.name === "ListMark") {
          const mark = view.state.doc.sliceString(node.from, node.to);
          const after = view.state.doc.sliceString(node.to, node.to + 5);
          // Task items are drawn by their checkbox; ordered items keep their numbers.
          // The dot covers the marker and its space, so the text starts where wrapped lines do.
          if (/^[-*+]$/.test(mark) && /^[ \t]/.test(after) && !/^[ \t]+\[[ xX]\]/.test(after))
            ranges.push(bullet.range(node.from, node.to + 1));
        } else if (node.name === "TaskMarker") {
          const line = view.state.doc.lineAt(node.from);
          const prefix = view.state.doc.sliceString(line.from, node.from);
          const list = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+$/.exec(prefix);
          const from = list ? line.from + list[1].length : node.from;
          const checked = view.state.doc.sliceString(node.from + 1, node.from + 2) !== " ";
          ranges.push(
            Decoration.replace({
              atomic: true,
              widget: new TaskCheckbox(node.from + 1, checked, view.state.readOnly),
            }).range(
              from,
              // The checkbox covers its following space too (see the bullet above).
              view.state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to,
            ),
          );
          if (checked && node.to < line.to)
            ranges.push(Decoration.mark({ class: "cm-completed-task" }).range(node.to, line.to));
        } else if (node.name === "Image") {
          const source = view.state.doc.sliceString(node.from, node.to);
          const image = /^!\[([^\]\n]*)\]\(([^\s)]+)\)$/.exec(source);
          const name = imagePath.exec(image?.[2] ?? "")?.[1];
          const line = view.state.doc.lineAt(node.from);
          const editingLine =
            view.hasFocus &&
            view.state.selection.ranges.some(
              (range) => range.from <= line.to && range.to >= line.from,
            );
          if (name && image && !editingLine)
            ranges.push(
              Decoration.replace({
                atomic: true,
                widget: new RepositoryImage(name, image[1]),
              }).range(node.from, node.to),
            );
        } else if (node.name === "FencedCode") {
          // A code block shows as one panel. Its fences (and the language) are hidden unless the
          // caret is on that line, as in the Mac app; the Markdown itself is unchanged.
          const first = view.state.doc.lineAt(node.from);
          const last = view.state.doc.lineAt(node.to);
          const closes = last.number > first.number && /^\s*(`{3,}|~{3,})\s*$/.test(last.text);
          for (let number = first.number; number <= last.number; number++) {
            const line = view.state.doc.line(number);
            const fence = number === first.number || (number === last.number && closes);
            const editingLine =
              view.hasFocus &&
              view.state.selection.ranges.some(
                (range) => range.from <= line.to && range.to >= line.from,
              );
            const classes = ["cm-code-line"];
            if (number === first.number) classes.push("cm-code-first");
            if (number === last.number) classes.push("cm-code-last");
            if (fence) classes.push(editingLine ? "cm-code-fence" : "cm-fence-hidden");
            ranges.push(Decoration.line({ class: classes.join(" ") }).range(line.from));
            if (fence && !editingLine && line.to > line.from)
              ranges.push(Decoration.replace({}).range(line.from, line.to));
          }
        } else if (node.name === "HorizontalRule") {
          // "---" shows as a rule away from the caret (as the Mac app always drew it).
          const line = view.state.doc.lineAt(node.from);
          const editingLine =
            view.hasFocus &&
            view.state.selection.ranges.some(
              (range) => range.from <= line.to && range.to >= line.from,
            );
          if (!editingLine) {
            ranges.push(Decoration.line({ class: "cm-rule" }).range(line.from));
            ranges.push(Decoration.replace({}).range(node.from, node.to));
          }
        } else if (node.name === "HeaderMark") {
          const line = view.state.doc.lineAt(node.from);
          const editingLine =
            view.hasFocus &&
            view.state.selection.ranges.some(
              (range) => range.from <= line.to && range.to >= line.from,
            );
          if (!editingLine)
            ranges.push(
              Decoration.replace({ atomic: true }).range(node.from, Math.min(line.to, node.to + 1)),
            );
        }
      },
    });
  return Decoration.set(ranges, true);
}
const liveMarkdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = taskDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.state.readOnly !== update.startState.readOnly ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        this.decorations = taskDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export /** Hidden marks, widgets and their atomic ranges; dropped in raw (source) mode. */
const liveExtensions = [
  liveMarkdown,
  EditorView.atomicRanges.of(
    (view) =>
      view.plugin(liveMarkdown)?.decorations.update({
        filter: (_from, _to, value) => Boolean(value.spec.atomic),
      }) ?? Decoration.none,
  ),
];
