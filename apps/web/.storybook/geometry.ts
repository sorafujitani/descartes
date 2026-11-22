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

/** Layout assertions must run in Chromium; happy-dom/jsdom cannot measure these regressions. */
export function expectReadableMarkdown(canvasElement: HTMLElement) {
  expectApplicationTheme(canvasElement);
  const article = canvasElement.querySelector<HTMLElement>("article.sora-prose");
  expect(article, "Markdown preview exists").not.toBeNull();
  if (!article) return;
  const viewport = article.ownerDocument.defaultView!;
  const bounds = article.getBoundingClientRect();
  expect(bounds.width, "readable document width").toBeGreaterThanOrEqual(
    Math.min(300, viewport.innerWidth - 40),
  );
  expect(bounds.right, "preview fits viewport").toBeLessThanOrEqual(viewport.innerWidth + 1);
  expect(bounds.left, "preview starts inside viewport").toBeGreaterThanOrEqual(0);
  expect(
    article.ownerDocument.documentElement.scrollWidth,
    "no horizontal page overflow",
  ).toBeLessThanOrEqual(viewport.innerWidth + 1);
  expect(
    parseFloat(viewport.getComputedStyle(article).fontSize),
    "readable text size",
  ).toBeGreaterThanOrEqual(14);

  const blocks = [...article.children].filter(
    (element) => element.getBoundingClientRect().height > 0,
  );
  expect(blocks.length, "fixture exercises multiple blocks").toBeGreaterThan(7);
  for (const [index, block] of blocks.entries()) {
    const box = block.getBoundingClientRect();
    if (index > 0) {
      const previous = blocks[index - 1].getBoundingClientRect();
      expect(box.top - previous.bottom, `gap before ${block.tagName} #${index}`).toBeLessThan(
        Math.min(96, viewport.innerHeight / 5),
      );
    }
    if (block.matches("p")) {
      expect(box.height, "normal paragraph is not viewport-height").toBeLessThan(
        viewport.innerHeight / 3,
      );
    }
  }
  for (const item of article.querySelectorAll("li")) {
    expect(item.getBoundingClientRect().height, "list row is compact").toBeLessThan(
      viewport.innerHeight / 4,
    );
  }
  const ordinaryList = article.querySelector("ul:not(:has(input))");
  expect(ordinaryList, "ordinary bullet list exists").not.toBeNull();
  if (ordinaryList) expect(viewport.getComputedStyle(ordinaryList).listStyleType).not.toBe("none");
  expect(
    canvasElement.querySelectorAll(
      'textarea[aria-label="項目を追加"], input[aria-label="項目を追加"], textarea[aria-label="本文を追加"], input[aria-label="本文を追加"]',
    ),
  ).toHaveLength(0);
}
