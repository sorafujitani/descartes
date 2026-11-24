import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import { NoteView } from "./NoteView";
import { markdownFixture } from "../.storybook/fixtures";
import { expectReadableEditor } from "../.storybook/geometry";

const meta = {
  title: "Documents/NoteView",
  component: NoteView,
  args: { markdown: markdownFixture, onChange: fn() },
  render: function Editor(args) {
    const [markdown, setMarkdown] = useState(args.markdown);
    return (
      <NoteView
        {...args}
        markdown={markdown}
        onChange={(next, persist) => {
          args.onChange(next, persist);
          setMarkdown(next);
        }}
      />
    );
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: "48rem", margin: "auto", padding: "1rem" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NoteView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const IntegratedDocument: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    await expect(canvas.getAllByRole("textbox")).toHaveLength(1);
    expectReadableEditor(canvasElement);
    await userEvent.click(editor);
    await userEvent.keyboard("{End}{Enter}自然に続けて書けます。");
    await expect(editor).toHaveTextContent("自然に続けて書けます。");
    expectReadableEditor(canvasElement);
  },
};

export const InteractiveChecklist: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const checkboxes = await canvas.findAllByRole("checkbox", { name: "チェックを切り替える" });
    await expect(checkboxes[0]).not.toBeChecked();
    await userEvent.click(checkboxes[0]);
    await waitFor(() =>
      expect(canvas.getAllByRole("checkbox", { name: "チェックを切り替える" })[0]).toBeChecked(),
    );
    await expect(canvas.getAllByRole("textbox", { name: "Markdown本文" })).toHaveLength(1);
    expectReadableEditor(canvasElement);
  },
};

/** The same todo commands as the Mac app: "[]" while typing and ⌘Return on any line. */
export const TodoCreation: Story = {
  args: { markdown: "# T" },
  play: async ({ canvasElement, userEvent, args }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    const checkboxes = () => canvas.queryAllByRole("checkbox", { name: "チェックを切り替える" });
    await userEvent.click(editor);
    await userEvent.keyboard(`{${mod}>}{End}{/${mod}}{Enter}- [[] 牛乳{Enter}卵`);
    await waitFor(() => expect(checkboxes()).toHaveLength(2));
    await expect(args.onChange).toHaveBeenLastCalledWith("# T\n- [ ] 牛乳\n- [ ] 卵", false);
    // An empty todo ends the list; ⌘Return makes the new paragraph a todo again.
    await userEvent.keyboard(`{Enter}{Enter}パン{${mod}>}{Enter}{/${mod}}`);
    await waitFor(() => expect(checkboxes()).toHaveLength(3));
    await expect(args.onChange).toHaveBeenLastCalledWith(
      "# T\n- [ ] 牛乳\n- [ ] 卵\n- [ ] パン",
      false,
    );
    // ⌘Return again checks it and saves like a checkbox click.
    await userEvent.keyboard(`{${mod}>}{Enter}{/${mod}}`);
    await waitFor(() => expect(checkboxes()[2]).toBeChecked());
    await expect(args.onChange).toHaveBeenLastCalledWith(
      "# T\n- [ ] 牛乳\n- [ ] 卵\n- [x] パン",
      true,
    );
    expectReadableEditor(canvasElement);
  },
};

export const BulletDots: Story = {
  args: { markdown: "# T\n- 箇条書き\n  * ネスト\n- [ ] ToDo\n1. 番号" },
  play: async ({ canvasElement, userEvent, args }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    // Bullets show dots (like the Mac app); tasks show checkboxes and numbers stay visible.
    await waitFor(() => expect(canvasElement.querySelectorAll(".cm-bullet")).toHaveLength(2));
    await expect(editor).not.toHaveTextContent(/^-|\n-/);
    await expect(editor).toHaveTextContent("1. 番号");
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    // ⌘Return on a bullet keeps its marker and adds the checkbox.
    await userEvent.click(editor);
    await userEvent.keyboard(`{${mod}>}{Home}{/${mod}}{ArrowDown}{End}{${mod}>}{Enter}{/${mod}}`);
    await expect(args.onChange).toHaveBeenLastCalledWith(
      "# T\n- [ ] 箇条書き\n  * ネスト\n- [ ] ToDo\n1. 番号",
      false,
    );
    await waitFor(() => expect(canvasElement.querySelectorAll(".cm-bullet")).toHaveLength(1));
  },
};

export const NaturalListEditing: Story = {
  args: { markdown: "# List" },
  play: async ({ canvasElement, userEvent, args }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.click(editor);
    await userEvent.keyboard(`{${mod}>}a{/${mod}}# List{Enter}{Enter}- [[ ] first{Enter}second`);
    await waitFor(() =>
      expect(canvas.getAllByRole("checkbox", { name: "チェックを切り替える" })).toHaveLength(2),
    );
    await expect(args.onChange).toHaveBeenLastCalledWith(
      "# List\n\n- [ ] first\n- [ ] second",
      false,
    );
    await userEvent.keyboard("{Enter}{Enter}paragraph");
    await expect(canvas.getAllByRole("checkbox", { name: "チェックを切り替える" })).toHaveLength(2);
    await expect(args.onChange).toHaveBeenLastCalledWith(
      expect.stringMatching(/\nparagraph$/),
      false,
    );
    await expect(canvas.queryByRole("textbox", { name: "項目を追加" })).not.toBeInTheDocument();
    expectReadableEditor(canvasElement);
  },
};
