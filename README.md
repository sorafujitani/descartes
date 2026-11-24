# Descartes

A single-user Markdown notebook for the web, mobile (installable online PWA), and macOS (native SwiftUI/AppKit app). One Cloudflare Worker serves the React app and the authenticated API. A separate **private GitHub repository** holds ordinary Markdown files and screenshots and remains the source of truth. An optional, rebuildable **D1/FTS5 search index** avoids re-fetching unchanged documents after a Worker restart; the notebook also works without that index.

## Quick start

Use the Node version in `.node-version` and pnpm 12.21.0. At the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm dev:demo
```

Open the local address printed by `cf dev`. Create a document beginning with `# Title`, attach a screenshot, preview it and save. Demo mode uses a **loopback-only, in-memory** Worker, makes no GitHub requests and loses all content on restart. Do not use it to store real documents.

## Workspace

| Path              | Responsibility                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `apps/web`        | React PWA, CodeMirror live editor, Ox Content preview, Storybook and Cloudflare configuration |
| `apps/api`        | Hono HTTP boundary, Access JWT verification, repository interface and GitHub storage adapter  |
| `apps/macos`      | Native Markdown notebook with a window-sized NSTextView, title search and SHA-checked saves   |
| `packages/shared` | Document types, title convention, API client                                                  |

The mobile and web clients use the same UI. Install from the browser's install menu or **Add to Home Screen** on iOS. No offline cache or offline sync. The Mac app uses its own native editor and connects directly to the same API; it does not launch a browser.

## Toolchain

Vite+ pins the Vite, Rolldown, Vitest, Oxlint and Oxfmt toolchain. The root `vite.config.ts` configures checks and tests; the web package adds the React and Cloudflare plugins. Use the workspace-local CLI instead of requiring a globally installed version.

```sh
pnpm exec vp toolchain  # inspect the resolved versions
pnpm fmt                # format via Vite+
pnpm check              # TypeScript, formatting and lint
pnpm test               # Vitest; no GitHub/Cloudflare account needed
pnpm build:macos        # on macOS: signed local .app at apps/macos/dist/Descartes.app
pnpm test:macos         # Swift tests; see below for loopback integration tests
pnpm storybook          # interactive UI catalogue; no secrets or private documents
pnpm test:storybook     # real Chromium, mobile + desktop interaction/layout checks
pnpm test:production    # built app + actual CSP headers, offline Chromium editing/save smoke test
pnpm gate:deploy        # check + unit + Storybook + browser tests + production-policy smoke test
pnpm deploy:check       # required gate, then Worker/web build with cf deploy --dry-run
pnpm run deploy         # required gate, then production deployment (not pnpm's built-in deploy command)
```

## Connect your private notebook

1. Prepare a **separate private repository** with an initialized `main` branch (a README commit is enough). The Worker credential is a fine-grained GitHub token restricted to that repo, with **Contents: read and write** and metadata read. Never put it in either client.
2. In Cloudflare Zero Trust, configure GitHub as an identity provider and a **self-hosted Access application** covering the entire notebook hostname. Add an **Allow** policy for your own account/email only, and a **Service Auth** policy for a dedicated desktop service token. Do not enable a bypass or an all-users policy. Access handles login; the Worker independently verifies the JWT signature, issuer, audience and expiration for every API request.
3. Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars`. Set `GITHUB_REPOSITORY` to `owner/repo`, `GITHUB_TOKEN` to the restricted token, `ACCESS_ISSUER` to the HTTPS team origin, and `ACCESS_AUD` to the Access application's audience. The branch is configured in `apps/web/cloudflare.config.ts`. Do not commit secrets.
4. When ready to publish, from `apps/web` run `pnpm exec cf auth login`; then from the workspace root use `pnpm run deploy --secrets-file .dev.vars` for the initial secret upload, or `pnpm run deploy` to retain existing secrets. The deployment script runs the UI gate before calling Cloudflare. Publish only behind the configured Access application. For local development against real data, `pnpm dev` also requires a valid Access assertion on API requests; use the demo for unauthenticated local work.
5. On the Mac, put the HTTPS Worker origin and the scoped Cloudflare Access service token in `~/.config/descartes/desktop-access.json` (mode `0600`; keys `origin`, `client_id`, `client_secret`). This is **not** the GitHub token. The API client refuses redirects to avoid forwarding credentials.

## Web editor and UI gate

The normal view is one CodeMirror document: click and type in place, select/paste across paragraphs, continue lists with Return, and use one undo history. There are no per-line input forms or separate “add item/body” fields. Markdown is kept as text rather than reserialized from blocks; task widgets do not create checkboxes inside fenced code. Checking a task (or ⌘Return on it) saves the current document snapshot, including any other pending edits. Ordinary typing is autosaved (see [Autosave](#autosave)); **保存** or ⌘S saves immediately. A save may finish while typing continues; newer edits remain visible and are saved next. **プレビュー** is optional, not a prerequisite for reading/checking/editing the note.

The previous segmented-form implementation reused a full-editor viewport-height CSS rule for every paragraph/code field, creating giant gaps. It also broke whole-document selection/paste and disconnected editing shortcuts. Do not reintroduce that architecture or global list resets: ordinary Markdown bullets must remain visible. The Storybook regression cases cover the integrated editor, task actions, full-document paste/undo, natural list continuation, search and list loading/error states, and real block geometry at mobile/desktop widths.

Run `pnpm storybook` for manual review (use `--port 6007` if 6006 is occupied). On a fresh machine, run `pnpm --filter @descartes/web install:browser` once. `pnpm run deploy` and `pnpm deploy:check` fail before Cloudflare if type/lint/unit/build/story interaction/layout checks fail. Direct `cf deploy` or `pnpm --filter @descartes/web exec cf deploy` deliberately bypasses this repository gate and is not the normal release path. Storybook is isolated from the Cloudflare plugin and uses synthetic in-memory APIs, never real credentials/documents. See [Storybook setup and test details](apps/web/.storybook/README.md).

`pnpm test:production` additionally loads the compiled application with the real `public/_headers` CSP, using only local API/asset mocks. It checks that CodeMirror's styles and wrapping are applied and that editing/checking/saving work without CSP violations at both widths. The CSP permits trusted runtime style elements needed by CodeMirror, but still forbids inline JavaScript and inline HTML style attributes; no Markdown-provided HTML/CSS is executed.

## Native Mac app

With Xcode installed, run `pnpm build:macos`, copy `apps/macos/dist/Descartes.app` to `~/Applications`, and open it. The build is ad-hoc signed for local use, not notarized for distribution. Targets macOS 14+.

Type directly in the window. Start the first line with `# Title`. **⌘P** finds a document, **⌘N** starts a new one, and edits are autosaved (see [Autosave](#autosave)); **⌘S** commits immediately. Headings and fenced code are styled in place, not converted to HTML. The app remembers the last open document and window frame. A conflicting save retains the unsaved draft and stops autosave; copy it before reopening the latest version. Switching documents, quitting and switching to another app save first; the app asks before discarding only changes that could not be saved.

The web app and the Mac app share the same Markdown editing commands. On the web, press **⌘K** or **ショートカット**. On the Mac, use **⌘K** or the **⌘** button. Completed tasks are muted and struck through in the note view and in preview. Fenced code is shown as a Document Design System code block; its fences (and the language after ` ``` `) are hidden except on the caret's line, where they are muted and editable; read-only preview always hides them. Return after an opening fence adds the closing fence and puts the caret inside, unless the fence opens an existing block below; a new block above other blocks never pairs with their fences. Typing the closing fence by hand steps over the added one. On both clients, **⌘Return** turns plain text, bullets and numbered items (or every selected line) into tasks (`- [ ] `) and otherwise toggles them, and typing `[]` (or `［］`, or the Japanese IME's `「」`) at the start of a line or bullet creates a task. Both show bullets as dots and tasks as outlined checkboxes in the same column; the command logic lives in `packages/shared/src/edit.ts` and is mirrored in the Mac app's `MarkdownCommands.swift`, with the same test tables on both sides. On the Mac, the checklist button does the same as ⌘Return, clicking a checkbox toggles it without moving the caret (also in preview), and bullets/checkboxes stay aligned with the text while typing, follow the zoom level, and wrapped item text lines up after them.

**Keyboard editing** (also listed in the File, Edit and Note menus):

| Keys                    | Action                                                                          |
| ----------------------- | ------------------------------------------------------------------------------- |
| ⌘⇧P / ⌘E                | Toggle read-only preview / return from preview to editing                       |
| ⌘P, ↑↓, Return, Esc     | Search titles, select, open, dismiss                                            |
| ⌘F, ⌘G / ⌘⇧G            | Find in the current note, next / previous match                                 |
| ⌘⌥[ / ⌘⌥]               | Previous / next Markdown heading outside fenced code                            |
| Return                  | Continue lists, quotes and tasks; an empty item outdents if nested, else exits  |
| Return after ` ``` `    | Add the closing fence (if nothing closes the block) and type inside it          |
| Return at heading text  | Insert an empty line above the heading instead of splitting `##` from its text  |
| Tab / ⇧Tab              | Indent / outdent the current list item; elsewhere Tab inserts a tab             |
| ⌘Return                 | Make the line (or every selected line) a task, or toggle its checkbox           |
| `[]` at a line start    | Becomes a task (`- [ ] `); a space typed right after it is absorbed             |
| ⌘← / ←                  | Stop after a bullet/checkbox first; hidden markers never need extra key presses |
| ⌘B / ⌘I / ⌘⇧`           | Wrap the selection in bold, italic or inline code                               |
| ⌘L                      | Insert a Markdown link and select its URL for typing                            |
| ⌘E (editing)            | Inline code                                                                     |
| ⌘K                      | Show actions and shortcuts; use ↑↓ and Return to execute                        |
| ⌘+ (or ⌘=), ⌘−, ⌘0      | Increase, decrease or reset the note zoom (saved between launches)              |
| ⌫ after a styled marker | Remove the entire bullet, checkbox or heading marker in one edit                |

Standalone notebook image references (PNG, JPEG and WebP) display as images in styled editing and preview. Source mode shows their Markdown. External URLs are never requested by the native image loader.

The appearance control at the top right adjusts background transparency without fading the text. The editor and title picker share the Document Design System palette and system fonts. The macOS Reduce Transparency setting overrides the glass effect.

To test without credentials, run `pnpm dev:demo --port 8788` and launch `open -n apps/macos/dist/Descartes.app --args --demo`. With that Worker running, `DESCARTES_TEST_DEMO=1 pnpm test:macos` exercises the native editor, create/read/update and conflicts against the in-memory repository. Demo mode never sends credentials.

## Autosave

Both clients save without ⌘S. Each save is one Git commit (one Worker request, two GitHub API calls and one D1 write), and GitHub limits content-creating requests to roughly 80 per minute and 500 per hour, so saves are coalesced rather than sent per keystroke:

- A save starts after **4 seconds** without typing, and at the latest **45 seconds** after the first unsaved change during continuous typing. This keeps sustained writing to a few dozen commits per hour.
- Saves also start immediately when switching documents, when the window loses focus, and on the web when the tab is hidden or closed (`keepalive` request; the unsaved-change warning still appears until the save is acknowledged). The Mac app saves before quitting.
- Only one save is in flight. Edits made meanwhile are saved next, using the SHA returned by the previous save. Saving never makes the editor read-only.
- Drafts without a `# Title` first line are not autosaved. A conflict (HTTP 409) stops autosave until an explicit save succeeds or another document is opened. Other failures are retried after 30 seconds.

The intervals are `autosaveTiming` in `apps/web/src/App.tsx` and `Notebook.Timing` in the Mac app.

## Data and limits

- Documents live at `docs/<uuid>.md`. The first line is the title (`# Title`); renaming does not change the ID or URL. Edits are committed by autosave or an explicit save and require the SHA read by the editor. A stale save is rejected without replacing the editor's draft.
- PNG/JPEG/WebP uploads up to 4 MiB go to `assets/<uuid>.<ext>` immediately. The editor inserts a relative Markdown reference, which is kept once the document is saved (autosave included). Cancelling the edit leaves the uploaded file in Git.
- Title lists use pages of up to 16 documents with D1, or 32 without it. The web client displays pages progressively, independently of opening a document. Local title search is immediate; **本文も検索** enables case-insensitive, Unicode-normalized title/body substring search (all whitespace-separated terms must match, title matches first, at most 50 results with snippets). The Mac picker remains title-only.
- Repository tree snapshots are reused for 15 seconds in a warm Worker, then revalidated using GitHub ETags. External Git edits can take up to 15 seconds to appear in lists/search; opening a document always reads its current SHA. A local save invalidates the current adapter's snapshot immediately.
- SHA-keyed title/content caches, request coalescing and a repository-wide limit of six simultaneous blob reads reduce GitHub traffic. Caches are scoped by repository, branch and credential. With D1, only missing Git blob SHAs are fetched and indexed. Once the current tree is indexed, a search returns the best 50 matches in a single API page, including on a cold Worker. Without D1, full-text search scans the notebook in bounded pages.
- Ox Content parses Markdown in a dedicated browser Worker with sanitization enabled and MDX disabled. DOMPurify sanitizes the result before insertion. Only repository screenshots are displayed inline. The stored Markdown is unchanged. Rendered HTML is cached only in bounded page memory, never localStorage/IndexedDB.
- Web saves acknowledge the submitted snapshot without blocking further typing. A second save uses the returned SHA; later keystrokes remain dirty. Unchanged documents do not create a commit. The storage adapter serializes same-isolate branch writes; independent Worker isolates and external edits still rely on GitHub SHA conflicts.

## Editor behaviour tests

Editing bugs are caught with keystroke scenarios rather than only unit tests of the command functions:

- **Shared scenarios** — [`tests/fixtures/editing-scenarios.json`](tests/fixtures/editing-scenarios.json) lists a starting note, caret, keys (`{return}`, `{tab}`, `{cmd-return}`, …) and the expected Markdown/caret. The Mac suite types them into the real `NSTextView` (`EditorScenarioTests.testSharedScenariosMatchTheWebEditor`) and Storybook types them into the real CodeMirror editor in Chromium (`EditingScenarios.stories.tsx`). A behaviour difference between the clients fails one side; add a scenario for every editing bug fixed.
- **Mac invariants after every key** — `Scenario` in `EditorScenarioTests.swift` checks after each keystroke and IME step that the caret line (and any IME composition) is visible, typing attributes are visible, the caret is never inside a hidden marker, incremental styling equals a full restyle, and the notebook text mirrors the view. One undo group per simulated key keeps undo/redo realistic.
- **Shared command unit tests** — `tests/edit.test.ts` covers `packages/shared/src/edit.ts` (Return, Backspace, ⌘Return, `[]`, fences, CRLF) quickly in `pnpm test`.

## Architecture and performance verification

`apps/api/src/routes.ts` owns Hono routing, write-origin checks, validation and JSON errors. `auth.ts` verifies Access JWTs before the production repository resolver can be reached. `repository.ts` is the storage contract; both the loopback demo and GitHub adapter implement it. Repository privacy checks are coalesced only while in flight, **not cached across requests**. All API responses, including errors, remain private/no-store.

GitHub-backed scans inspect at most 16 documents per request with D1 (allowing for individual large-row writes), or 32 without it, leaving room for authentication, privacy and tree reads under [Workers Free's 50-subrequest budget](https://developers.cloudflare.com/workers/platform/limits/#subrequests). Fully indexed searches query D1's trigram FTS5 index, join against the current Git tree's IDs/SHAs, and return one bounded result page. One- and two-character terms use exact normalized substring filtering rather than silently losing Japanese/short matches. Search cursors refer to inspected documents, not matches: an empty result page may still have a next cursor. The shared client follows every page, progressively reports the best 50 matches and supports cancellation between pages. This request bound does not guarantee that arbitrarily large documents fit the Free plan's CPU budget.

The GitHub adapter bounds content retention to 8 MiB of UTF-16 text / 1,024 blobs, 4,096 titles and 16 search result sets per repository. Production retains at most four credential-scoped adapters. The browser renderer retains at most eight source/HTML pairs within 4 MiB. These caches are optimizations, not durable data stores; eviction or a cold isolate must not affect correctness.

The native editor re-attributes only the edited line when a single UTF-16 edit preserves paragraph/fence state. Newlines, fence changes, batched edits, IME composition and presentation changes fall back to full styling. Image completion re-styles only the current matching image lines; ImageIO thumbnail decoding runs on a separate serial actor. Code backgrounds outside the dirty visible character range are skipped. Later cached offsets still shift linearly, and a single enormous visible code block can still require full block layout.

```sh
pnpm test        # API, cache/concurrency, search, client, actual WASM, jsdom save/render races and sanitization
pnpm check      # TypeScript, formatting and lint
pnpm build      # production Worker + web, including the dedicated Markdown Worker
pnpm test:macos # keystroke scenarios with invariants, shared web/Mac scenarios, incremental styling, IME, undo
# With pnpm dev:demo --port 8788 running:
DESCARTES_TEST_DEMO=1 pnpm test:macos # native create/read/update/conflicts and screenshot rendering
```

Regression tests assert request counts, concurrency bounds and styled-line counts instead of noisy wall-clock thresholds. They verify tree invalidation after saves/external SHA changes, immutable index writes completed in reverse order, deleted-file exclusion, credential isolation, failed-load retries, stale asynchronous responses and preserving edits during saves. SQL tests use both real SQLite/FTS5 and workerd's D1 implementation. The Mac picker tests measure the actual field editor between the native search/clear button rectangles, including live resizing and IME. Run `pnpm bench:search` for a synthetic, local-SQLite cold-index / cold-Worker comparison; those elapsed times are **not production latency measurements**.

## Persistent search index and deployment

The production configuration declares `SEARCH_DB` using D1 database `descartes-search`. Deployments without that binding retain the paged canonical search. Apply `apps/api/migrations/0001_search.sql` once with Cloudflare's migration CLI before enabling the binding. From `apps/web`:

```sh
pnpm exec cf auth login
pnpm exec cf d1 list
# Only if the database does not already exist:
pnpm exec cf d1 create --name descartes-search --read-replication-mode disabled
# Use the returned database UUID, not its name/binding:
pnpm exec cf d1 migrations apply <database-uuid> --dir ../api/migrations
pnpm --dir ../.. run deploy # required UI gate; retains existing secrets (initial deployment: add --secrets-file .dev.vars)
```

D1 stores private document text and an opaque digest of repository/branch/credential scope, **never the credential itself**. Provision it only in the intended account/jurisdiction. Index reads still require Access authentication and a fresh repository privacy check. Blob rows are immutable; every query joins the current tree, so an old reader cannot overwrite newer indexed text, and externally edited/deleted versions are not returned. Missing SHAs reconcile automatically during list/search/read/save requests. The D1 row/batch text budget is 2 MiB; pathological normalization expansion or unavailable/unmigrated D1 falls back to GitHub with a 30-second retry backoff. A successful GitHub commit is still acknowledged if index maintenance fails.

Old SHA versions and old credential scopes remain in this derived index until an operator purges them. To reclaim them or rebuild after changing the normalization/schema, clear `search_blobs` in the intended D1 database (its delete trigger also clears FTS entries); the next list/search backfills current Git SHAs. Never delete the GitHub repository when rebuilding this disposable index. Prefer versioned migrations for schema changes. No background full-repository sync or webhook secret is required.

## Measuring deployed requests

Every API response includes `Server-Timing` (auth, privacy, operation, total) and a random `X-Request-ID`, including error responses. Production emits a structured `api_request` record containing only operation name, method, status, timings and that request ID. It does not record document IDs, titles, Markdown, search queries, tokens or exception messages. Cloudflare observability is enabled with query-string redaction and automatic invocation URL logs disabled. Compare authorized read/list/search/save timings in client network tools or Cloudflare logs; do not use public latency/benchmark endpoints or log credentials. Actual production latency and throughput must be measured after deploying with the intended dataset and Access configuration. `pnpm verify:deploy` first compares the deployed HTML's JavaScript/CSS assets and their bytes with the latest local production build, then reuses the native client's existing scoped Access configuration for read-only list/read/search checks, timing/no-store headers and unauthenticated denial. A healthy old API is not proof that the new UI was published. Build locally before running it. It reports only verification status, asset counts and timings (not titles, document IDs, queries or credentials). It never creates/edits/deletes notebook documents; reads may populate the derived D1 index.

References: [Hono](https://hono.dev/), [Document Design System](https://github.com/sorafujitani/document-design-system), [Ox Content](https://github.com/ubugeeei-prod/ox-content), [Vite+](https://viteplus.dev/guide/), [Cloudflare CLI](https://developers.cloudflare.com/cf/projects/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
