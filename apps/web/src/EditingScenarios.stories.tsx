import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, waitFor } from "storybook/test";
import { NoteView } from "./NoteView";
import fixtures from "../../../tests/fixtures/editing-scenarios.json";

type Scenario = {
  name: string;
  doc: string;
  keys: string;
  expect: string;
  caret?: number | { after: string };
  select?: string;
  caretAfter?: string;
};

/**
 * The editing scenarios shared with the Mac app (tests/fixtures/editing-scenarios.json), typed
 * into the real CodeMirror editor. The Mac suite runs the same file against NSTextView, so a
 * behaviour difference between the two editors fails one of them.
 */
const meta = {
  title: "Documents/Editing scenarios",
  render: function Editor() {
    const [markdown, setMarkdown] = useState("# T\n");
    return <NoteView markdown={markdown} onChange={setMarkdown} />;
  },
} satisfies Meta;
export default meta;

/** Converts the shared key notation to user-event's keyboard syntax. */
function keyboard(keys: string, mod: string) {
  const named: Record<string, string> = {
    return: "{Enter}",
    tab: "{Tab}",
    backtab: "{Shift>}{Tab}{/Shift}",
    backspace: "{Backspace}",
    left: "{ArrowLeft}",
    right: "{ArrowRight}",
    up: "{ArrowUp}",
    down: "{ArrowDown}",
    // ⌘← / ⌘→ on the Mac (Home / End elsewhere), as in the Mac app.
    home: mod === "Meta" ? "{Meta>}{ArrowLeft}{/Meta}" : "{Home}",
    end: mod === "Meta" ? "{Meta>}{ArrowRight}{/Meta}" : "{End}",
    "cmd-return": `{${mod}>}{Enter}{/${mod}}`,
    "cmd-b": `{${mod}>}b{/${mod}}`,
    "cmd-i": `{${mod}>}i{/${mod}}`,
    "cmd-l": `{${mod}>}l{/${mod}}`,
    "cmd-shift-x": `{${mod}>}{Shift>}x{/Shift}{/${mod}}`,
    "cmd-backspace": `{${mod}>}{Backspace}{/${mod}}`,
    "shift-return": "{Shift>}{Enter}{/Shift}",
    delete: "{Delete}",
    undo: `{${mod}>}z{/${mod}}`,
    "alt-up": "{Alt>}{ArrowUp}{/Alt}",
    "alt-down": "{Alt>}{ArrowDown}{/Alt}",
  };
  return keys.replace(/\{([a-z-]+)\}|([[{])|([^[{]+)/g, (_, name, special, text) =>
    name ? named[name] : special ? special + special : text,
  );
}

export const SharedScenarios: StoryObj<typeof meta> = {
  play: async ({ canvasElement, userEvent }) => {
    const dom = await waitFor(() => {
      const editor = canvasElement.querySelector<HTMLElement>(".cm-editor");
      if (!editor) throw new Error("editor not mounted");
      return editor;
    });
    const view = EditorView.findFromDOM(dom)!;
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    const failures: string[] = [];
    const scenarios = fixtures.scenarios as Scenario[];
    await expect(scenarios.length).toBeGreaterThan(10);
    for (const scenario of scenarios) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: scenario.doc } });
      let anchor =
        typeof scenario.caret === "number"
          ? scenario.caret
          : scenario.caret
            ? scenario.doc.indexOf(scenario.caret.after) + scenario.caret.after.length
            : scenario.doc.length;
      let head = anchor;
      if (scenario.select) {
        anchor = scenario.doc.indexOf(scenario.select);
        head = anchor + scenario.select.length;
      }
      view.focus();
      view.dispatch({ selection: { anchor, head } });
      // "{paste:TEXT}" pastes; everything else is typed.
      for (const part of scenario.keys.split(/(\{paste:[^}]*\})/)) {
        const paste = /^\{paste:([^}]*)\}$/.exec(part);
        if (paste) {
          // A real paste event, as the browser sends for ⌘V; the editor reads clipboardData.
          const data = new DataTransfer();
          data.setData("text/plain", paste[1]);
          view.contentDOM.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          );
        } else if (part) await userEvent.keyboard(keyboard(part, mod));
      }
      const doc = view.state.doc.toString();
      if (doc !== scenario.expect)
        failures.push(
          `${scenario.name}: ${JSON.stringify(doc)} ≠ ${JSON.stringify(scenario.expect)}`,
        );
      else if (scenario.caretAfter) {
        const caret = view.state.selection.main.head;
        const expected = doc.indexOf(scenario.caretAfter) + scenario.caretAfter.length;
        if (caret !== expected) failures.push(`${scenario.name}: caret ${caret} ≠ ${expected}`);
      }
    }
    await expect(failures).toEqual([]);
  },
};

/** Fences are hidden away from the caret and shown on its line, like the Mac app. */
export const CodeBlockFences: StoryObj<typeof meta> = {
  play: async ({ canvasElement, userEvent }) => {
    const dom = await waitFor(() => {
      const editor = canvasElement.querySelector<HTMLElement>(".cm-editor");
      if (!editor) throw new Error("editor not mounted");
      return editor;
    });
    const view = EditorView.findFromDOM(dom)!;
    const doc = "# T\n```js\nconsole.log(1)\n```\n後";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    view.focus();
    view.dispatch({ selection: { anchor: doc.length } });
    const content = () => dom.querySelector(".cm-content")!.textContent ?? "";
    await waitFor(() => expect(content()).not.toContain("```"));
    await expect(content()).toContain("console.log(1)");
    await expect(dom.querySelectorAll(".cm-code-line")).toHaveLength(3);
    // On the fence's line it is visible and editable.
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(content()).toContain("```"));
    await expect(content()).not.toContain("```js");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    await waitFor(() => expect(content()).toContain("```js"));
    await userEvent.keyboard("{End}{Backspace}{Backspace}ts{ArrowDown}");
    await waitFor(() => expect(content()).not.toContain("```"));
    await expect(view.state.doc.toString()).toBe("# T\n```ts\nconsole.log(1)\n```\n後");
  },
};

/** Quotes, numbered todos, strikethrough and ⌘-click links, as in the Mac app. */
export const RichMarkdown: StoryObj<typeof meta> = {
  play: async ({ canvasElement, userEvent }) => {
    const dom = await waitFor(() => {
      const editor = canvasElement.querySelector<HTMLElement>(".cm-editor");
      if (!editor) throw new Error("editor not mounted");
      return editor;
    });
    const view = EditorView.findFromDOM(dom)!;
    const doc =
      "# T\n1. [ ] 一\n2. [x] 二\n> 引用\n~~消す~~\n[サイト](https://example.com/a)\n末尾";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    view.focus();
    view.dispatch({ selection: { anchor: doc.length } });
    await waitFor(() => expect(dom.querySelectorAll(".cm-task-checkbox")).toHaveLength(2));
    await expect(dom.querySelectorAll(".cm-quote-bar")).toHaveLength(1);
    await expect(dom.querySelector(".cm-content")!.textContent).not.toContain("> 引用");
    // Backspace right after the hidden "> " removes the quote marker.
    view.dispatch({ selection: { anchor: doc.indexOf("引用") } });
    await userEvent.keyboard("{Backspace}");
    await expect(view.state.doc.toString()).toContain("\n引用\n");
    // ⌘-click (Ctrl-click elsewhere) on a link opens it; a plain click only moves the caret.
    const opened: string[] = [];
    const open = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    try {
      const at = view.state.doc.toString().indexOf("サイト") + 1;
      const point = view.coordsAtPos(at)!;
      const press = (modifier: boolean) =>
        view.contentDOM.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: point.left + 1,
            clientY: (point.top + point.bottom) / 2,
            metaKey: modifier && /Mac/.test(navigator.platform),
            ctrlKey: modifier && !/Mac/.test(navigator.platform),
          }),
        );
      press(false);
      await expect(opened).toEqual([]);
      press(true);
      await expect(opened).toEqual(["https://example.com/a"]);
    } finally {
      window.open = open;
    }
  },
};

/** Re-rendering (e.g. on blur) must not reuse a checkbox element for a bullet. */
export const WidgetsKeepTheirKind: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const dom = await waitFor(() => {
      const editor = canvasElement.querySelector<HTMLElement>(".cm-editor");
      if (!editor) throw new Error("editor not mounted");
      return editor;
    });
    const view = EditorView.findFromDOM(dom)!;
    const doc = "# 買い物メモ\n1. [ ] 牛乳\n- 箇条書き\n  - ネスト\n> 引用";
    // Start from a note whose checkbox sits where the new note has a nested bullet, then
    // replace it through browser input, as typing or pasting does (not a transaction).
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "# T\n- 箇条書き\n  * ネスト\n- [ ] ToDo\n1. 番号",
      },
    });
    view.focus();
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    document.execCommand("insertText", false, doc);
    await waitFor(() => expect(view.state.doc.toString()).toBe(doc));
    view.contentDOM.blur();
    await waitFor(() => expect(dom.querySelectorAll(".cm-bullet")).toHaveLength(2));
    await expect(dom.querySelectorAll(".cm-task-checkbox")).toHaveLength(1);
    await expect(dom.querySelectorAll(".cm-quote-bar")).toHaveLength(1);
  },
};

/**
 * Live preview: inline Markdown hides away from the caret and shows while editing it; list and
 * quote text (including wrapped lines) starts at the same x as the next lines.
 */
export const LivePreviewLayout: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const dom = await waitFor(() => {
      const editor = canvasElement.querySelector<HTMLElement>(".cm-editor");
      if (!editor) throw new Error("editor not mounted");
      return editor;
    });
    const view = EditorView.findFromDOM(dom)!;
    const long = "折り返しを確かめるための長い文章です。".repeat(6);
    const doc = [
      "# T",
      "本文 **太字** と *斜体* と ~~消す~~ と `code` と [リンク](https://example.com/x)",
      "- [ ] " + long,
      "- " + long,
      "1. " + long,
      "10. " + long,
      "> " + long,
      "> > 二重",
      "---",
      "末尾",
    ].join("\n");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    view.focus();
    view.dispatch({ selection: { anchor: doc.length } });
    const content = () => view.contentDOM.textContent ?? "";
    await waitFor(() => expect(content()).not.toContain("**"));
    for (const syntax of ["~~", "`", "](https", "[リンク]"])
      await expect(content()).not.toContain(syntax);
    await expect(content()).toContain("リンク");
    await expect(dom.querySelectorAll(".cm-quote-bar")).toHaveLength(3);
    await expect(dom.querySelectorAll(".cm-rule")).toHaveLength(1);
    // Inside **太字** the marks are shown for editing.
    view.dispatch({ selection: { anchor: doc.indexOf("太字") + 1 } });
    await waitFor(() => expect(content()).toContain("**太字**"));
    view.dispatch({ selection: { anchor: doc.length } });
    // First and wrapped lines of every item start at the same x (the marker is outside).
    for (const prefix of ["- [ ] ", "- ", "1. ", "10. ", "> "]) {
      const line = view.state.doc.line(doc.split("\n").findIndex((l) => l === prefix + long) + 1);
      const first = view.coordsAtPos(line.from + prefix.length, 1)!;
      const last = view.coordsAtPos(line.to, -1)!;
      await expect(last.top).toBeGreaterThan(first.bottom - 1); // it really wraps
      // The start of the line containing the end: the wrapped line's left edge.
      const wrapped = view.coordsAtPos(
        view.moveToLineBoundary(EditorSelection.cursor(line.to), false).head,
        1,
      )!;
      await expect(Math.abs(wrapped.left - first.left)).toBeLessThan(1.5);
    }
    // Nesting is easy to see: every level moves the marker clearly to the right (it used to be
    // only the width of the two leading spaces).
    const nested = "# T\n- 一\n  - 二\n    - 三\n- [ ] 四\n  - [ ] 五\n1. 六\n   1. 七";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nested } });
    const textX = (label: string) => view.coordsAtPos(nested.indexOf(label), 1)!.left;
    for (const [parent, child] of [
      ["一", "二"],
      ["二", "三"],
      ["四", "五"],
      ["六", "七"],
    ])
      await expect(textX(child) - textX(parent)).toBeGreaterThan(20);
  },
};
