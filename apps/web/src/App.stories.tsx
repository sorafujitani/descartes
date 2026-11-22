import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { App } from "./App";
import { createMockApi, documentFixtures } from "../.storybook/fixtures";
import { expectReadableEditor } from "../.storybook/geometry";

const meta = {
  title: "Application/App",
  component: App,
  args: { initialId: documentFixtures[0].id },
  loaders: [() => ({ mock: createMockApi() })],
  render: (args, { loaded }) => <App {...args} api={loaded.mock.api} />,
} satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ExistingNote: Story = {
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    await expect(editor).toBeVisible();
    await expect(canvas.getAllByRole("textbox", { name: "Markdown本文" })).toHaveLength(1);
    expectReadableEditor(canvasElement);
    const tasks = canvas.getAllByRole("checkbox", { name: "チェックを切り替える" });
    await expect(tasks[0]).not.toBeChecked();
    await userEvent.click(tasks[0]);
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() => expect(mock.saved.at(-1)?.markdown).toContain("- [x] 切符を予約する"));
    await expect(canvas.getByRole("textbox", { name: "Markdown本文" })).toBeVisible();
  },
};

export const EditAndSave: Story = {
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    await userEvent.click(editor);
    await userEvent.keyboard("{End}{Enter}ブラウザから追記した本文。");
    await expect(editor).toHaveTextContent("ブラウザから追記した本文。");
    await expect(canvas.getByRole("button", { name: "保存" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "保存" }));
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() =>
      expect(mock.saved.at(-1)?.markdown).toContain("\nブラウザから追記した本文。"),
    );
    await expect(canvas.findByText("保存しました。")).resolves.toBeVisible();
    expectReadableEditor(canvasElement);
  },
};

export const NewDocument: Story = {
  args: { initialId: null },
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "新規作成" }));
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    await userEvent.click(editor);
    await userEvent.keyboard("{End}新しいノート{Enter}{Enter}ひとつの本文に入力します。");
    await userEvent.click(canvas.getByRole("button", { name: "保存" }));
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() =>
      expect(mock.saved.at(-1)?.markdown).toContain("ひとつの本文に入力します。"),
    );
    await expect(canvas.getAllByRole("textbox", { name: "Markdown本文" })).toHaveLength(1);
    await expect(canvas.queryByRole("textbox", { name: "項目を追加" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("textbox", { name: "本文を追加" })).not.toBeInTheDocument();
  },
};

export const PasteUndoAndSave: Story = {
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    const source =
      "# 貼り付け 😀\n\n- first\n- second\n\n- [ ] todo\n\n```md\n- [ ] not a task\n```\n\n本文と **強調** をそのまま保存。";
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.click(editor);
    await userEvent.keyboard(`{${mod}>}a{/${mod}}`);
    await userEvent.paste(source);
    await waitFor(() =>
      expect(canvas.getAllByRole("checkbox", { name: "チェックを切り替える" })).toHaveLength(1),
    );
    await expect(editor).toHaveTextContent("貼り付け 😀");
    await userEvent.keyboard(`{${mod}>}z{/${mod}}`);
    await expect(editor).not.toHaveTextContent("貼り付け 😀");
    await userEvent.keyboard(`{${mod}>}{Shift>}z{/Shift}{/${mod}}`);
    await expect(editor).toHaveTextContent("貼り付け 😀");
    await userEvent.click(canvas.getByRole("button", { name: "保存" }));
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() => expect(mock.saved.at(-1)?.markdown).toBe(source));
    await expect(editor).toBeVisible();
    expectReadableEditor(canvasElement);
  },
};

export const EditingShortcutsAndPreview: Story = {
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.click(editor);
    await userEvent.keyboard(`{${mod}>}a{/${mod}}`);
    await userEvent.paste("# Shortcuts\n\nalpha");
    await userEvent.keyboard(`{${mod}>}{End}{/${mod}}{Shift>}{Home}{/Shift}{${mod}>}b{/${mod}}`);
    await expect(editor).toHaveTextContent("**alpha**");
    await userEvent.click(canvas.getByRole("button", { name: "保存" }));
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() => expect(mock.saved.at(-1)?.markdown).toBe("# Shortcuts\n\n**alpha**"));
    await userEvent.keyboard(`{${mod}>}{Shift>}p{/Shift}{/${mod}}`);
    await expect(canvas.findByRole("heading", { name: "Shortcuts" })).resolves.toBeVisible();
    await expect(canvasElement.querySelector("article.sora-prose strong")).toHaveTextContent(
      "alpha",
    );
    await userEvent.keyboard(`{${mod}>}e{/${mod}}`);
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: "Markdown本文" })).toHaveFocus(),
    );
    await expect(editor).toHaveTextContent("**alpha**");
  },
};

export const ListError: Story = {
  args: { initialId: null },
  loaders: [() => ({ mock: createMockApi({ listError: "文書一覧を読み込めませんでした。" }) })],
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByRole("alert")).resolves.toHaveTextContent(
      "文書一覧を読み込めませんでした。",
    );
  },
};
