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

/** No save button or status text: ⌘S saves now (autosave runs after a pause). */
export const EditAndSave: Story = {
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    await expect(canvas.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "プレビュー" })).not.toBeInTheDocument();
    await userEvent.click(editor);
    await userEvent.keyboard("{End}{Enter}ブラウザから追記した本文。");
    await expect(editor).toHaveTextContent("ブラウザから追記した本文。");
    await expect(canvasElement.querySelector('[role="status"]')).toBeNull();
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${mod}>}s{/${mod}}`);
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() =>
      expect(mock.saved.at(-1)?.markdown).toContain("\nブラウザから追記した本文。"),
    );
    await expect(canvasElement.querySelector('[role="status"]')).toBeNull();
    expectReadableEditor(canvasElement);
  },
};

export const NewDocument: Story = {
  args: { initialId: null },
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "新規ノート" }));
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    // The empty title line asks for a title.
    await expect(canvasElement.querySelector(".cm-title-placeholder")).toHaveTextContent(
      "タイトル",
    );
    await userEvent.click(editor);
    await userEvent.keyboard("{End}新しいノート{Enter}{Enter}ひとつの本文に入力します。");
    await expect(canvasElement.querySelector(".cm-title-placeholder")).toBeNull();
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${mod}>}s{/${mod}}`);
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() =>
      expect(mock.saved.at(-1)?.markdown).toContain("ひとつの本文に入力します。"),
    );
    await expect(canvas.getByRole("button", { name: "ノート一覧" })).toHaveTextContent(
      "新しいノート",
    );
    await expect(canvas.getAllByRole("textbox", { name: "Markdown本文" })).toHaveLength(1);
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
    await userEvent.keyboard(`{${mod}>}s{/${mod}}`);
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() => expect(mock.saved.at(-1)?.markdown).toBe(source));
    await expect(editor).toBeVisible();
    expectReadableEditor(canvasElement);
  },
};

export const EditingShortcuts: Story = {
  play: async ({ canvasElement, userEvent, loaded }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.click(editor);
    await userEvent.keyboard(`{${mod}>}a{/${mod}}`);
    await userEvent.paste("# Shortcuts\n\nalpha");
    await userEvent.keyboard(`{${mod}>}{End}{/${mod}}{Shift>}{Home}{/Shift}{${mod}>}b{/${mod}}`);
    await expect(editor).toHaveTextContent("**alpha**");
    await userEvent.keyboard(`{${mod}>}s{/${mod}}`);
    const mock = loaded.mock as ReturnType<typeof createMockApi>;
    await waitFor(() => expect(mock.saved.at(-1)?.markdown).toBe("# Shortcuts\n\n**alpha**"));
    // The page title follows the note's title.
    await waitFor(() => expect(document.title).toBe("Shortcuts — Descartes"));
  },
};

/** ⌘P opens the note switcher: recent notes first, then the rest; type, ↑↓ and Return. */
export const SwitchNotes: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole("textbox", { name: "Markdown本文" });
    expectReadableEditor(canvasElement);
    await userEvent.click(editor);
    const mod = /Mac/.test(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${mod}>}p{/${mod}}`);
    const palette = await canvas.findByRole("dialog", { name: "ノート一覧" });
    const search = within(palette).getByRole("searchbox", { name: "ノートを検索" });
    await waitFor(() => expect(search).toHaveFocus());
    // The note opened in this story comes first, under 最近.
    await waitFor(() =>
      expect(within(palette).getAllByRole("button")[0]).toHaveTextContent("週末のメモ"),
    );
    await expect(palette).toHaveTextContent("最近");
    await userEvent.keyboard("読書{Enter}");
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: "Markdown本文" })).toHaveTextContent(
        "週末に本を読む",
      ),
    );
    await expect(palette).not.toBeVisible();
    await expect(canvas.getByRole("button", { name: "ノート一覧" })).toHaveTextContent(
      "読書ノート",
    );
    // Arrow keys choose, Escape closes without switching.
    await userEvent.click(canvas.getByRole("button", { name: "ノート一覧" }));
    await waitFor(() =>
      expect(within(palette).getByRole("searchbox", { name: "ノートを検索" })).toHaveFocus(),
    );
    await userEvent.keyboard("{ArrowDown}");
    await expect(within(palette).getAllByRole("button")[1]).toHaveClass("active");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(palette).not.toBeVisible());
    await expect(canvas.getByRole("button", { name: "ノート一覧" })).toHaveTextContent(
      "読書ノート",
    );
    // Full-text search shows snippets.
    await userEvent.click(canvas.getByRole("button", { name: "ノート一覧" }));
    await userEvent.click(within(palette).getByRole("checkbox", { name: "本文も検索" }));
    await userEvent.type(
      within(palette).getByRole("searchbox", { name: "本文も検索" }),
      "ブラウザ",
    );
    await waitFor(() =>
      expect(within(palette).getByRole("button", { name: /仕事の記録/ })).toBeVisible(),
    );
  },
};

export const ListError: Story = {
  args: { initialId: null },
  loaders: [() => ({ mock: createMockApi({ listError: "文書一覧を読み込めませんでした。" }) })],
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "ノート一覧" }));
    await expect(within(canvasElement).findByRole("alert")).resolves.toHaveTextContent(
      "文書一覧を読み込めませんでした。",
    );
  },
};
