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
