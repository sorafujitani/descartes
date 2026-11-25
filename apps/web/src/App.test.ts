// @vitest-environment jsdom
import { afterEach, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { client, type Document } from "@descartes/shared";
import { EditorView } from "@codemirror/view";
import { App, autosaveTiming } from "./App";
import { NotePalette } from "./NotePalette";
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
  localStorage.clear();
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
  const node = [...host.querySelectorAll("button")].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  assert.ok(node, `Missing button: ${label}`);
  return node;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
/** ⌘S: there is no save button; autosave runs after a pause and ⌘S saves at once. */
async function saveNow() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
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
  // Loading the list shows no status text (the note itself is already editable).
  assert.equal(host.querySelector('[role="status"]'), null);
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
  await click("新規ノート");
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
  assert.equal(host.querySelector('[role="status"]'), null);
  await saveNow();
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
  await click("新規ノート");
  await inputDocument("# Unsaved\n本文");
  await saveNow();
  assert.equal(editor().state.doc.toString(), "# Unsaved\n本文");
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /競合/);
});

test("a late title page cannot replace a locally saved title", async () => {
  const list = deferred<Response>();
  const api = client("https://app.test", {}, async (_url, init) =>
    init?.method === "POST" ? Response.json(saved) : list.promise,
  );
  await mount(createElement(App, { api, initialId: null }));
  await click("新規ノート");
  await inputDocument(saved.markdown);
  await saveNow();
  await act(async () => {
    list.resolve(Response.json({ items: [{ id: saved.id, title: "Old title" }], next: null }));
  });
  await click("ノート一覧");
  const palette = host.querySelector(".palette")!;
  assert.match(palette.textContent!, /Draft/);
  assert.equal(palette.textContent!.includes("Old title"), false);
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
    createElement(NotePalette, {
      api,
      docs: [],
      open: true,
      loading: false,
      error: "",
      onClose() {},
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

function fakeTimers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function recordingApi(
  respond?: (
    request: Request,
    body: { markdown: string; sha?: string },
  ) => Response | Promise<Response>,
) {
  const writes: { request: Request; body: { markdown: string; sha?: string } }[] = [];
  const api = client("https://app.test", {}, async (url, init) => {
    const request = new Request(String(url), init);
    if (request.method === "GET")
      return Response.json(String(url).includes("?cursor=") ? { items: [], next: null } : saved);
    const body = await request.clone().json();
    writes.push({ request, body });
    return (
      (await respond?.(request, body)) ??
      Response.json({
        ...saved,
        markdown: body.markdown,
        sha: String(writes.length + 1).repeat(40),
      })
    );
  });
  return { api, writes };
}

test("typing autosaves once after a pause, coalescing every keystroke into one commit", async () => {
  fakeTimers();
  const { api, writes } = recordingApi();
  await mount(createElement(App, { api, initialId: saved.id }));
  for (const text of ["# Draft\na", "# Draft\nab", "# Draft\nabc"]) {
    await inputDocument(text);
    await advance(1_000);
  }
  assert.equal(writes.length, 0);
  assert.equal(host.querySelector('[role="status"]'), null, "no 'unsaved' status text");
  await advance(autosaveTiming.idle);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].request.method, "PUT");
  assert.deepEqual(writes[0].body, { markdown: "# Draft\nabc", sha: saved.sha });
  await advance(autosaveTiming.max * 2);
  assert.equal(writes.length, 1, "a saved note is not written again");
});

test("continuous typing is still saved at the maximum interval", async () => {
  fakeTimers();
  const { api, writes } = recordingApi();
  await mount(createElement(App, { api, initialId: saved.id }));
  let body = "# Draft\n";
  for (let elapsed = 0; elapsed < autosaveTiming.max; elapsed += 1_000) {
    body += "x";
    await inputDocument(body);
    await advance(1_000);
  }
  assert.equal(writes.length, 1);
  assert.ok(writes[0].body.markdown.length > "# Draft\n".length);
  assert.equal(editor().state.readOnly, false, "autosave never blocks typing");
});

test("an untitled draft is not autosaved", async () => {
  fakeTimers();
  const { api, writes } = recordingApi();
  await mount(createElement(App, { api, initialId: null }));
  await click("新規ノート");
  await inputDocument("# \n本文だけ");
  await advance(autosaveTiming.max * 2);
  assert.equal(writes.length, 0);
  // The empty title line asks for a title instead of a status message.
  assert.ok(host.querySelector(".cm-title-placeholder"));
});

test("a conflict stops autosave until an explicit save", async () => {
  fakeTimers();
  let conflict = true;
  const { api, writes } = recordingApi(() =>
    conflict ? Response.json({ error: "保存が競合しました" }, { status: 409 }) : undefined!,
  );
  await mount(createElement(App, { api, initialId: saved.id }));
  await inputDocument("# Draft\nlocal");
  await advance(autosaveTiming.idle);
  assert.equal(writes.length, 1);
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /競合/);
  await inputDocument("# Draft\nlocal more");
  await advance(autosaveTiming.max * 2);
  assert.equal(writes.length, 1, "autosave does not retry a conflict");
  assert.equal(editor().state.sliceDoc(), "# Draft\nlocal more");
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /自動保存を止めています/);
  conflict = false;
  await saveNow();
  assert.equal(writes.length, 2);
  assert.equal(host.querySelector('[role="alert"]'), null);
  await inputDocument("# Draft\nresumed");
  await advance(autosaveTiming.idle);
  assert.equal(writes.length, 3, "autosave resumes after a successful save");
});

test("a failed autosave is retried later", async () => {
  fakeTimers();
  let down = true;
  const { api, writes } = recordingApi(() =>
    down ? Response.json({ error: "unavailable" }, { status: 503 }) : undefined!,
  );
  await mount(createElement(App, { api, initialId: saved.id }));
  await inputDocument("# Draft\nretry");
  await advance(autosaveTiming.idle);
  assert.equal(writes.length, 1);
  down = false;
  await advance(autosaveTiming.retry);
  assert.equal(writes.length, 2);
});

test("switching documents saves first instead of asking to discard", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { api, writes } = recordingApi();
  await mount(createElement(App, { api, initialId: saved.id }));
  await inputDocument("# Draft\nunsaved");
  await click("新規ノート");
  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.markdown, "# Draft\nunsaved");
  assert.equal(editor().state.sliceDoc(), "# ");
  confirm.mockRestore();
});

test("hiding the page saves immediately with a keepalive request", async () => {
  const { api, writes } = recordingApi();
  await mount(createElement(App, { api, initialId: saved.id }));
  await inputDocument("# Draft\nbackground");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  visibility.mockRestore();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].request.keepalive, true);
  assert.equal(writes[0].body.markdown, "# Draft\nbackground");
});
