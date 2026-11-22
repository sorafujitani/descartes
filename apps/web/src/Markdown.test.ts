// @vitest-environment jsdom
import { afterEach, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "./Markdown";
import { renderer } from "./renderer";

vi.mock("./renderer", () => ({ renderer: { render: vi.fn() } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  vi.resetAllMocks();
});
async function mount(source: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(Markdown, { source }));
  });
}

test("Worker HTML is sanitized and only repository image references survive", async () => {
  const name = "00000000-0000-0000-0000-000000000001.png";
  vi.mocked(renderer.render).mockResolvedValue(
    `<h1>Title</h1><script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">link</a><img src="../assets/${name}" srcset="https://evil.test/track.png 2x" onerror="alert(1)"><img src="https://evil.test/track.png" alt="external">`,
  );
  await mount("source");
  assert.equal(host.querySelectorAll("img").length, 1);
  assert.equal(host.querySelector("img")!.getAttribute("src"), "/api/assets/" + name);
  assert.equal(host.querySelector("img")!.hasAttribute("srcset"), false);
  assert.equal(host.querySelector("img")!.hasAttribute("onerror"), false);
  assert.equal(host.querySelector("script, iframe"), null);
  assert.equal(host.querySelector("a")!.hasAttribute("href"), false);
  assert.match(host.textContent!, /external/);
});

test("a task row toggles by display order and keeps the previous preview visible", async () => {
  let finish!: (html: string) => void;
  vi.mocked(renderer.render).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const toggled: number[] = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(Markdown, {
        source: "- [ ] a\n- [x] b",
        documentKey: "doc",
        onToggleTask: (index) => toggled.push(index),
      }),
    );
  });
  await act(async () => {
    finish(
      '<ul><li><input type="checkbox" disabled> a</li><li><input type="checkbox" checked disabled> b</li></ul>',
    );
  });
  const boxes = host.querySelectorAll("input");
  assert.equal(boxes[0].disabled, false);
  await act(async () => {
    boxes[1].closest("li")!.click();
  });
  assert.deepEqual(toggled, [1]);
  assert.equal(boxes[1].checked, false);
  vi.mocked(renderer.render).mockImplementation(() => new Promise(() => {}));
  await act(async () => {
    root.render(
      createElement(Markdown, {
        source: "- [ ] a\n- [ ] b",
        documentKey: "doc",
        onToggleTask: (index) => toggled.push(index),
      }),
    );
  });
  assert.equal(host.querySelectorAll("input").length, 2);
});

test("nested task and link clicks do not toggle their ancestor tasks", async () => {
  vi.mocked(renderer.render).mockResolvedValue(
    '<ul><li><input type="checkbox"> parent <a href="#section">link</a><ul><li><input type="checkbox"> child</li></ul></li></ul>',
  );
  const toggled: number[] = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(Markdown, { source: "nested", onToggleTask: (index) => toggled.push(index) }),
    );
  });
  const boxes = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => {
    boxes[1].click();
  });
  assert.deepEqual(toggled, [1]);
  assert.equal(boxes[0].checked, false);
  await act(async () => {
    host.querySelector("a")!.click();
  });
  assert.deepEqual(toggled, [1]);
});

test("a stale render cannot overwrite a later document", async () => {
  let finishOld!: (html: string) => void;
  vi.mocked(renderer.render)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce("<h1>New document</h1>");
  await mount("old");
  await act(async () => {
    root.render(createElement(Markdown, { source: "new" }));
  });
  await act(async () => {
    finishOld("<h1>Old document</h1>");
  });
  assert.match(host.textContent!, /New document/);
  assert.doesNotMatch(host.textContent!, /Old document/);
});
