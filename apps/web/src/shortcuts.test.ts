import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { actionFor } from "./shortcuts";

const key = (key: string, modifiers: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  }) as KeyboardEvent;

test("formatting shortcuts match the Mac menu", () => {
  assert.equal(actionFor(key("b", { metaKey: true })), "bold");
  assert.equal(actionFor(key("i", { metaKey: true })), "italic");
  assert.equal(actionFor(key("X", { metaKey: true, shiftKey: true })), "strike");
  assert.equal(actionFor(key("x", { ctrlKey: true, shiftKey: true })), "strike");
  assert.equal(actionFor(key("x", { metaKey: true })), null, "⌘X stays cut");
  assert.equal(actionFor(key("`", { metaKey: true, shiftKey: true })), "code");
});
