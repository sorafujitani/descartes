import { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { DocumentList } from "./DocumentList";
import { createMockApi, documentFixtures } from "../.storybook/fixtures";

const meta = {
  title: "Documents/DocumentList",
  component: DocumentList,
  args: {
    api: createMockApi().api,
    docs: documentFixtures.map(({ id, title }) => ({ id, title })),
    currentId: documentFixtures[0].id,
    busy: false,
    loading: false,
    error: "",
    // A serializable placeholder; render creates the actual ref outside Storybook args.
    searchRef: { current: null },
    onSelect: fn(),
  },
  render: function List(args) {
    const searchRef = useRef<HTMLInputElement>(null);
    return <DocumentList {...args} searchRef={searchRef} />;
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: "24rem", padding: "1rem" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DocumentList>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Search: Story = {
  play: async ({ canvasElement, userEvent, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("searchbox", { name: "タイトルで検索" }), "週末");
    await expect(canvas.findByRole("button", { name: "週末のメモ" })).resolves.toBeVisible();
    await expect(canvas.queryByRole("button", { name: "仕事の記録" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "週末のメモ" }));
    await expect(args.onSelect).toHaveBeenCalledWith(documentFixtures[0].id);
  },
};

export const FullTextSearch: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox", { name: "本文も検索" }));
    await userEvent.type(canvas.getByRole("searchbox", { name: "本文も検索" }), "ブラウザ");
    await expect(canvas.findByRole("button", { name: /仕事の記録/ })).resolves.toBeVisible();
    await expect(canvas.findByText(/ブラウザで回帰テスト/)).resolves.toBeVisible();
    await expect(canvas.queryByRole("button", { name: "週末のメモ" })).not.toBeInTheDocument();
  },
};

export const Empty: Story = {
  args: { docs: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("該当する文書はありません。")).toBeVisible();
  },
};

export const Loading: Story = {
  args: { docs: [], loading: true, busy: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("文書一覧を読み込み中…");
    await expect(canvas.getByRole("button", { name: "新規作成" })).toBeDisabled();
  },
};

export const Error: Story = {
  args: { docs: [], error: "文書一覧を読み込めませんでした。" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "文書一覧を読み込めませんでした。",
    );
  },
};

export const SearchError: Story = {
  args: { api: createMockApi({ searchError: "検索を実行できませんでした。" }).api },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox", { name: "本文も検索" }));
    await userEvent.type(canvas.getByRole("searchbox", { name: "本文も検索" }), "週末");
    await expect(canvas.findByRole("alert")).resolves.toHaveTextContent(
      "検索を実行できませんでした。",
    );
  },
};
