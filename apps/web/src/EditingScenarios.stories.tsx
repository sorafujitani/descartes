import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
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
      await userEvent.keyboard(keyboard(scenario.keys, mod));
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
