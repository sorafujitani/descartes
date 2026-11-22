// Exercise the built application with its real response headers. All requests are local mocks;
// this never uses deployment credentials, GitHub, or notebook documents.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = createRequire(new URL("../apps/web/package.json", import.meta.url))(
  "playwright",
);
const root = fileURLToPath(
  new URL("../apps/web/.cloudflare/output/v1/workers/default/assets/", import.meta.url),
);
const headerFile = await readFile(new URL("../apps/web/public/_headers", import.meta.url), "utf8");
const policy = headerFile
  .split("\n")
  .find((line) => line.trim().startsWith("Content-Security-Policy:"))
  ?.trim()
  .slice("Content-Security-Policy:".length)
  .trim();
assert.ok(policy, "production CSP is present");
assert.ok(
  !/script-src[^;]*'unsafe-inline'/.test(policy),
  "inline JavaScript must remain forbidden",
);
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  for (const [name, width, height] of [
    ["mobile", 390, 844],
    ["desktop", 1280, 900],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    let doc = {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Production UI",
      sha: "1".repeat(40),
      markdown: "# Production UI\n\n- first\n- second\n\n- [ ] task\n\n本文",
    };
    const violations = [];
    const saves = [];
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        /Content Security Policy|violates.*policy|refused to/i.test(message.text())
      )
        violations.push(message.text());
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== "http://notebook.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        if (request.method() === "PUT") {
          const update = request.postDataJSON();
          if (update.sha !== doc.sha)
            return route.fulfill({ status: 409, json: { error: "Conflict" } });
          saves.push(update.markdown);
          doc = { ...doc, markdown: update.markdown, sha: String(saves.length + 1).repeat(40) };
        }
        return route.fulfill({
          json:
            url.pathname === "/api/docs"
              ? { items: [{ id: doc.id, title: doc.title }], next: null }
              : doc,
        });
      }
      const file = resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      if (!file.startsWith(resolve(root) + sep)) return route.abort();
      try {
        await route.fulfill({
          body: await readFile(file),
          contentType: mime[extname(file)] ?? "application/octet-stream",
          headers: { "Content-Security-Policy": policy, "X-Content-Type-Options": "nosniff" },
        });
      } catch {
        await route.fulfill({ status: 404 });
      }
    });
    await page.goto("http://notebook.test/?doc=" + doc.id);
    const editor = page.getByRole("textbox", { name: "Markdown本文" });
    await editor.waitFor();
    assert.equal(
      await page.locator(".cm-editor").evaluate((element) => getComputedStyle(element).display),
      "flex",
      "CodeMirror's trusted runtime stylesheet is applied",
    );
    assert.ok(
      ["pre-wrap", "break-spaces"].includes(
        await editor.evaluate((element) => getComputedStyle(element).whiteSpace),
      ),
      "the document preserves whitespace and wraps with its real production policy",
    );
    assert.equal(await page.getByRole("textbox", { name: "項目を追加" }).count(), 0);
    const taskSaved = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.status() === 200,
    );
    await page.getByRole("checkbox", { name: "チェックを切り替える" }).check();
    await taskSaved;
    assert.ok(saves[0]?.includes("- [x] task"), "task changes are saved without a mode switch");
    await editor.click();
    await editor.press("ControlOrMeta+End");
    await editor.press("Enter");
    await editor.pressSequentially("updated");
    const textSaved = page.waitForResponse(
      (response) => response.request().method() === "PUT" && response.status() === 200,
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await textSaved;
    assert.ok(
      saves.at(-1)?.endsWith("\nupdated"),
      "ordinary editing and save work in the production bundle",
    );
    assert.equal(violations.length, 0, "the production UI has no CSP violations");
    console.log(
      JSON.stringify({
        viewport: name,
        productionStyles: true,
        editing: true,
        checkboxSave: true,
        cspViolations: 0,
      }),
    );
    await page.close();
  }
} finally {
  await browser.close();
}
