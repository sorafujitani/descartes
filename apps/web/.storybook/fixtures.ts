import { matchDocument, searchTerms, type client, type Document } from "@descartes/shared";

export const markdownFixture = `# 週末のメモ

普通の段落です。Markdownを一枚の本文として読み書きできます。

続く段落です。段落の間に画面いっぱいの空白は入りません。

## 買い物

- 牛乳を買う
- コーヒーを買う
  - 豆を選ぶ

1. お湯を沸かす
2. コーヒーを淹れる

## チェックリスト

- [ ] 切符を予約する
- [x] 宿を予約する

## コード

\`\`\`ts
const message = "hello";
console.log(message);
\`\`\`

> 引用も本文の一部として表示します。

**太字**と*斜体*、\`inline code\`、[リンク](https://example.com)を表示します。

| 項目 | 状態 |
| --- | --- |
| メモ | 確認済み |
`;

export const documentFixtures: Document[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    title: "週末のメモ",
    markdown: markdownFixture,
    sha: "fixture-1",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    title: "仕事の記録",
    markdown: "# 仕事の記録\n\nブラウザで回帰テストを確認する。",
    sha: "fixture-2",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    title: "読書ノート",
    markdown: "# 読書ノート\n\n週末に本を読む。",
    sha: "fixture-3",
  },
];

/** In-memory only. No fetch, Cloudflare, GitHub, Access credentials or private notes. */
export function createMockApi(
  options: { listError?: string; searchError?: string; saveError?: string } = {},
) {
  const documents = new Map(documentFixtures.map((doc) => [doc.id, { ...doc }]));
  const saved: Document[] = [];
  const summaries = () => [...documents.values()].map(({ id, title }) => ({ id, title }));
  const api: ReturnType<typeof client> = {
    async *pages(signal) {
      signal?.throwIfAborted();
      if (options.listError) throw new Error(options.listError);
      yield summaries();
    },
    async list(signal) {
      signal?.throwIfAborted();
      if (options.listError) throw new Error(options.listError);
      return summaries();
    },
    async get(id, signal) {
      signal?.throwIfAborted();
      const doc = documents.get(id);
      if (!doc) throw new Error("文書が見つかりません。");
      return { ...doc };
    },
    async search(query, signal, onPage) {
      signal?.throwIfAborted();
      if (options.searchError) throw new Error(options.searchError);
      const items = [...documents.values()].flatMap((doc) => {
        const match = matchDocument(doc.id, doc.title, doc.markdown, searchTerms(query));
        return match ? [match] : [];
      });
      onPage?.(items);
      return { items };
    },
    async save(markdown, base) {
      if (options.saveError) throw new Error(options.saveError);
      const doc = {
        id: base?.id ?? "44444444-4444-4444-8444-444444444444",
        title: markdown.split("\n", 1)[0].replace(/^#\s+/, ""),
        markdown,
        sha: `fixture-save-${saved.length + 1}`,
      };
      documents.set(doc.id, doc);
      saved.push(doc);
      return { ...doc };
    },
    async attach() {
      throw new Error("Storybookでは画像アップロードを行いません。");
    },
  };
  return { api, saved };
}
