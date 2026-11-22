import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { toggleTaskAt } from "@descartes/shared";
import { Markdown } from "./Markdown";
import { markdownFixture } from "../.storybook/fixtures";
import { expectReadableMarkdown } from "../.storybook/geometry";

const meta = {
  title: "Documents/Markdown",
  component: Markdown,
  args: { source: markdownFixture },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: "48rem", margin: "auto", padding: "1rem" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RichDocument: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("heading", { name: "週末のメモ" })).resolves.toBeVisible();
    await waitFor(() =>
      expect(canvasElement.querySelector("article")).toHaveAttribute("aria-busy", "false"),
    );
    await expect(canvas.getByText('const message = "hello";', { exact: false })).toBeVisible();
    await expect(canvas.getAllByRole("checkbox")).toHaveLength(2);
    expectReadableMarkdown(canvasElement);
  },
};

export const ToggleChecklist: Story = {
  render: function Checklist(args) {
    const [source, setSource] = useState(args.source);
    return (
      <Markdown
        source={source}
        onToggleTask={(index) => setSource((text) => toggleTaskAt(text, index) ?? text)}
      />
    );
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const tasks = await canvas.findAllByRole("checkbox");
    await expect(tasks[0]).not.toBeChecked();
    await userEvent.click(tasks[0]);
    await waitFor(() => expect(canvas.getAllByRole("checkbox")[0]).toBeChecked());
    // The label/row is also a target, not just the small checkbox.
    await userEvent.click(canvas.getByText("切符を予約する", { exact: false }));
    await waitFor(() => expect(canvas.getAllByRole("checkbox")[0]).not.toBeChecked());
    expectReadableMarkdown(canvasElement);
  },
};
