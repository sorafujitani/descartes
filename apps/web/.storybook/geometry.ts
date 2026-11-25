import { expect } from "storybook/test";

function expectApplicationTheme(canvasElement: HTMLElement) {
  const document = canvasElement.ownerDocument;
  const style = document.defaultView!.getComputedStyle(document.body);
  expect(document.body.classList.contains("sora-theme"), "same body theme as index.html").toBe(
    true,
  );
  expect(style.getPropertyValue("--color-text").trim(), "production color tokens loaded").not.toBe(
    "",
  );
  expect(style.getPropertyValue("--font-body").trim(), "production font tokens loaded").not.toBe(
    "",
  );
  expect(style.fontFamily, "production system font applied").toContain("sans-serif");
  expect(style.backgroundImage, "production background applied").not.toBe("none");
}

export function expectReadableEditor(canvasElement: HTMLElement) {
  expectApplicationTheme(canvasElement);
  const editor = canvasElement.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Markdown本文"]',
  );
  expect(editor, "one integrated document editor").not.toBeNull();
  if (!editor) return;
  const viewport = editor.ownerDocument.defaultView!;
  const bounds = editor.getBoundingClientRect();
  expect(bounds.width, "readable editor width").toBeGreaterThanOrEqual(
    Math.min(280, viewport.innerWidth - 60),
  );
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right, "editor fits viewport").toBeLessThanOrEqual(viewport.innerWidth + 1);
  expect(
    editor.ownerDocument.documentElement.scrollWidth,
    "no horizontal page overflow",
  ).toBeLessThanOrEqual(viewport.innerWidth + 1);
  expect(parseFloat(viewport.getComputedStyle(editor).fontSize)).toBeGreaterThanOrEqual(14);
  expect(canvasElement.querySelectorAll(".note-field, .task-add, textarea")).toHaveLength(0);
  const lines = [...editor.querySelectorAll<HTMLElement>(".cm-line")];
  expect(lines.length, "real editable document lines").toBeGreaterThan(3);
  for (const [index, line] of lines.entries()) {
    const box = line.getBoundingClientRect();
    expect(box.height, "paragraph/list line is not viewport-height").toBeLessThan(
      viewport.innerHeight / 4,
    );
    if (index > 0) {
      expect(
        box.top - lines[index - 1].getBoundingClientRect().bottom,
        "no viewport-sized gap between lines",
      ).toBeLessThan(64);
    }
  }
}
