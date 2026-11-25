# Web UI regression gate

- `pnpm storybook`: standalone React/Vite Storybook at `http://127.0.0.1:6006`.
  Add `--port 6007` if that port is occupied.
- `pnpm build-storybook`: local static output in `apps/web/storybook-static`.
- `pnpm test:storybook`: every story/play function in **real Chromium**, at
  390×844 and 1280×900, and in **real WebKit** at 1280×900 (the engine of the Mac
  app's WKWebView editor and of Safari). No preview server or external API is needed.
- First-time/CI setup: `pnpm --filter @descartes/web install:browser`.
  Linux CI also needs Playwright's operating-system dependencies installed.

`main.ts` explicitly selects `.storybook/vite.config.ts`. Neither Storybook nor
its dedicated Vitest config merges the application's Cloudflare Vite config.
Stories inject the in-memory API from `fixtures.ts`; the Markdown worker/WASM,
application components, design-system CSS and application CSS are real.
No GitHub, Cloudflare, Access session, private notes or secrets are needed.

## What is checked

- App: one integrated document editor, natural typing/Enter, explicit save,
  checkbox persistence, new document and list error.
- NotePalette: the ⌘P note switcher — recent notes first, title/full-text search, keyboard selection, empty and error states.
- Markdown: paragraphs, headings, nested bullets, numbered lists, tasks, code,
  quote, inline formatting, links and table; checkbox and row interaction.
- NoteView: one accessible document textbox, typing, checkbox interaction and Return-to-continue/exit task lists.
- Full-document selection/paste, Undo/Redo and exact Markdown preservation on save.
- `geometry.ts`: real layout widths, readable font size, page overflow, compact
  paragraph/list blocks and CodeMirror lines, no viewport-sized gaps and no
  row-by-row/add-item fields. These assertions do not rely on DOM emulation or
  screenshot baselines.

`pnpm run deploy` and `pnpm deploy:check` run `gate:deploy` first (use `run deploy`, not pnpm's built-in workspace `deploy` command):

```text
check → unit/DOM tests → Storybook static build → Chromium/WebKit story/play tests → built-app/CSP smoke tests → cf deploy
```

Each command is joined with `&&`; a failure prevents Cloudflare deployment.
Direct low-level commands such as `pnpm --filter @descartes/web exec cf deploy`
can bypass this project gate and are not the standard deployment entry point.

`pnpm test:production` also tests the compiled application against its actual production CSP.
All API/asset requests are fulfilled locally; no real notes or credentials are used. It verifies
runtime editor CSS, preserved whitespace/wrapping, task persistence and ordinary editing/saving.
This catches restrictions absent from Storybook's development server (for example, a CSP that
silently blocks CodeMirror's injected styles).

## Toolchain compatibility

The registry's current stable Storybook packages are 10.6.8 and Playwright is
1.65.1. Storybook's framework peers support React 19 and Vite 8; addon-vitest's
peers support Vitest 5. The existing Vite+ 1.7.0 / Vite core 8.3.8000 / Vitest
5.1.0 / React 19.3.1 toolchain is retained, not downgraded.

`@vitest/browser-playwright` is deliberately **5.1.0**: its peer must exactly
match Vitest. Latest 5.1.1 requires Vitest 5.1.1, while this workspace pins 5.1.0
for Vite+. Storybook's optional `vite-plus` peer still lists pre-1.0 releases;
we do not downgrade or blanket-ignore peers. Static build, type checking and
real-browser execution validate this integration instead.

References (also checked against the installed declaration files):

- [Storybook Vitest addon](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon)
- [Storybook Vite configuration](https://storybook.js.org/docs/builders/vite)
- [Vitest Playwright provider](https://vitest.dev/config/browser/playwright)
- [Framework peer versions](https://registry.npmjs.org/@storybook/react-vite/latest)
- [Addon peer versions](https://registry.npmjs.org/@storybook/addon-vitest/latest)
- [Provider's exact Vitest peer](https://registry.npmjs.org/@vitest/browser-playwright/5.1.0)
