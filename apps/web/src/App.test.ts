// @vitest-environment jsdom
import { afterEach, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { client, type Document } from "@descartes/shared";
import { EditorView } from "@codemirror/view";
import { App } from "./App";
import { DocumentList } from "./DocumentList";

vi.mock("./Markdown", () => ({
  Markdown: ({
    source,
    onToggleTask,
  }: {
    source: string;
    onToggleTask?: (index: number) => void;
  }) =>
    createElement(
      "article",
      {},
      source,
      onToggleTask && createElement("button", { onClick: () => onToggleTask(0) }, "チェック切替"),
    ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// jsdom has no layout API. Geometry is asserted separately by the real Chromium Storybook suite.
if (!Range.prototype.getClientRects)
  Object.defineProperties(Range.prototype, {
    getClientRects: { value: () => Object.assign([], { item: () => null }), configurable: true },
    getBoundingClientRect: { value: () => new DOMRect(), configurable: true },
  });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}
function button(label: string) {
  const node = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  assert.ok(node, `Missing button: ${label}`);
  return node;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function input(node: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const proto =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function editor() {
  const element = host.querySelector<HTMLElement>('.cm-content[aria-label="Markdown本文"]');
  assert.ok(element, "one unified document editor is present");
  const view = EditorView.findFromDOM(element);
  assert.ok(view);
  return view;
}
async function inputDocument(value: string) {
  await act(async () => {
    const view = editor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  });
}
const saved: Document = {
  id: "00000000-0000-0000-0000-000000000001",
  title: "Draft",
  markdown: "# Draft",
  sha: "1".repeat(40),
};

test("selected document opens without waiting for the title index", async () => {
  const list = deferred<Response>();
  const api = client("https://app.test", {}, async (url) =>
    String(url).includes("?cursor=") ? list.promise : Response.json(saved),
  );
  await mount(createElement(App, { api, initialId: saved.id }));
  assert.equal(editor().state.doc.toString(), saved.markdown);
  assert.equal(host.querySelectorAll('[role="textbox"][aria-label="Markdown本文"]').length, 1);
  assert.equal(host.querySelector('[aria-label="項目を追加"], [aria-label="本文を追加"]'), null);
  assert.match(host.textContent!, /文書一覧を読み込み中/);
  await act(async () => {
    list.resolve(Response.json({ items: [], next: null }));
  });
});

test("checking a task stays on the note and saves without a mode switch", async () => {
  const requests: Request[] = [];
  const api = client("https://app.test", {}, async (url, init) => {
    const req = new Request(String(url), init);
    if (req.method === "PUT") {
      requests.push(req);
      return Response.json({ ...saved, markdown: "# Draft\n- [x] a", sha: "2".repeat(40) });
    }
    return Response.json({ ...saved, markdown: "# Draft\n- [ ] a" });
  });
  await mount(createElement(App, { api, initialId: saved.id }));
  const box = host.querySelector<HTMLInputElement>('.note input[type="checkbox"]')!;
  await act(async () => {
    box.click();
  });
  assert.equal(host.querySelector("textarea"), null);
  assert.equal(box.checked, true);
  assert.equal(requests.length, 1);
  assert.equal((await requests[0].json()).markdown, "# Draft\n- [x] a");
});

test("saving allows typing, preserves later edits, uses the acknowledged SHA, and prevents duplicate POSTs", async () => {
  const gate = deferred<Response>();
  const requests: Request[] = [];
  const api = client("https://app.test", {}, async (url, init) => {
    const req = new Request(String(url), init);
    if (req.method === "GET") return Response.json({ items: [], next: null });
    requests.push(req);
    if (requests.length === 1) return gate.promise;
    return Response.json({ ...saved, markdown: "# Draft\nLater", sha: "2".repeat(40) });
  });
  await mount(createElement(App, { api, initialId: null }));
  await click("新規作成");
  await inputDocument(saved.markdown);
  await act(async () => {
    for (let i = 0; i < 2; i++)
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }),
      );
  });
  assert.equal(requests.length, 1);
  assert.equal(editor().state.readOnly, false);
  await inputDocument("# Draft\nLater");
  await act(async () => {
    gate.resolve(Response.json(saved));
  });
  assert.equal(editor().state.doc.toString(), "# Draft\nLater");
  assert.equal(button("保存").disabled, false);
  assert.match(host.textContent!, /続きの変更は未保存/);
  await click("保存");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, "PUT");
  assert.equal(new URL(requests[1].url).pathname, "/api/docs/" + saved.id);
  assert.deepEqual(await requests[1].json(), { markdown: "# Draft\nLater", sha: saved.sha });
});

test("a conflict never clears the draft and the editor can retry", async () => {
  const api = client("https://app.test", {}, async (_url, init) =>
    init?.method === "POST"
      ? Response.json({ error: "保存が競合しました" }, { status: 409 })
      : Response.json({ items: [], next: null }),
  );
  await mount(createElement(App, { api, initialId: null }));
  await click("新規作成");
  await inputDocument("# Unsaved\n本文");
  await click("保存");
  assert.equal(editor().state.doc.toString(), "# Unsaved\n本文");
  assert.equal(button("保存").disabled, false);
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /競合/);
});

test("a late title page cannot replace a locally saved title", async () => {
  const list = deferred<Response>();
  const api = client("https://app.test", {}, async (_url, init) =>
    init?.method === "POST" ? Response.json(saved) : list.promise,
  );
  await mount(createElement(App, { api, initialId: null }));
  await click("新規作成");
  await inputDocument(saved.markdown);
  await click("保存");
  await act(async () => {
    list.resolve(Response.json({ items: [{ id: saved.id, title: "Old title" }], next: null }));
  });
  assert.equal(button("Draft").textContent, "Draft");
  assert.equal(host.querySelector("aside")!.textContent!.includes("Old title"), false);
});

test("rapid task changes serialize writes using the latest acknowledged SHA", async () => {
  const first = deferred<Response>();
  const requests: Request[] = [];
  const original = { ...saved, markdown: "# Draft\n- [ ] a\n- [ ] b" };
  const latest = "# Draft\n- [x] a\n- [x] b";
  const api = client("https://app.test", {}, async (url, init) => {
    const request = new Request(String(url), init);
    if (request.method === "GET")
      return Response.json(String(url).includes("?cursor=") ? { items: [], next: null } : original);
    requests.push(request);
    return requests.length === 1
      ? first.promise
      : Response.json({ ...original, markdown: latest, sha: "3".repeat(40) });
  });
  await mount(createElement(App, { api, initialId: saved.id }));
  await act(async () => {
    const boxes = host.querySelectorAll<HTMLInputElement>('.note input[type="checkbox"]');
    boxes[0].click();
    boxes[1].click();
  });
  assert.equal(requests.length, 1);
  assert.equal(editor().state.readOnly, false);
  assert.equal(editor().state.sliceDoc(), latest);
  await act(async () => {
    first.resolve(
      Response.json({ ...original, markdown: "# Draft\n- [x] a\n- [ ] b", sha: "2".repeat(40) }),
    );
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(await requests[1].json(), { markdown: latest, sha: "2".repeat(40) });
  assert.equal(editor().state.sliceDoc(), latest);
  assert.equal(button("保存").disabled, true);
});

test("live task editing preserves CRLF and full-document formatting", async () => {
  const markdown = "# Draft\r\n\r\n- [ ] a\r\n\r\n```md\r\n- [ ] literal\r\n```\r\n\r\n日本語 😀";
  const requests: Request[] = [];
  const api = client("https://app.test", {}, async (url, init) => {
    const request = new Request(String(url), init);
    if (request.method === "GET")
      return Response.json(
        String(url).includes("?cursor=") ? { items: [], next: null } : { ...saved, markdown },
      );
    requests.push(request);
    return Response.json({
      ...saved,
      markdown: markdown.replace("- [ ] a", "- [x] a"),
      sha: "2".repeat(40),
    });
  });
  await mount(createElement(App, { api, initialId: saved.id }));
  assert.equal(editor().state.sliceDoc(), markdown);
  assert.equal(host.querySelectorAll('.note input[type="checkbox"]').length, 1);
  await act(async () => {
    host.querySelector<HTMLInputElement>('.note input[type="checkbox"]')!.click();
  });
  assert.equal((await requests[0].json()).markdown, markdown.replace("- [ ] a", "- [x] a"));
});

test("full-text search debounces input and ignores a stale response even when transport ignores abort", async () => {
  vi.useFakeTimers();
  const searches: {
    query: string;
    response: ReturnType<typeof deferred<Response>>;
    signal?: AbortSignal | null;
  }[] = [];
  const api = client("https://app.test", {}, async (url, init) => {
    const response = deferred<Response>();
    searches.push({
      query: new URL(String(url)).searchParams.get("q")!,
      response,
      signal: init?.signal,
    });
    return response.promise;
  });
  await mount(
    createElement(DocumentList, {
      api,
      docs: [],
      busy: false,
      loading: false,
      error: "",
      searchRef: { current: null },
      onSelect() {},
    }),
  );
  await act(async () => {
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  const field = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await input(field, "old");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  await input(field, "new");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  assert.deepEqual(
    searches.map((search) => search.query),
    ["old", "new"],
  );
  assert.equal(searches[0].signal?.aborted, true);
  await act(async () => {
    searches[1].response.resolve(
      Response.json({
        items: [{ id: "new", title: "New match", snippet: "body", rank: 1 }],
        next: null,
      }),
    );
  });
  await act(async () => {
    searches[0].response.resolve(
      Response.json({
        items: [{ id: "old", title: "Stale match", snippet: "", rank: 1 }],
        next: null,
      }),
    );
  });
  assert.match(host.textContent!, /New match/);
  assert.doesNotMatch(host.textContent!, /Stale match/);
});
