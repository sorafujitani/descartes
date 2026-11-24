import { rankResults } from "./search.ts";

export type Summary = { id: string; title: string };
export type Document = Summary & { markdown: string; sha: string };
export type Page<T> = { items: T[]; next: number | null };
export type SearchResult = Summary & { snippet: string; rank: number };
export { matchDocument, normalizeSearch, rankResults, searchTerms } from "./search.ts";
export const titleOf = (markdown: string) =>
  /^#\s+(.+?)\s*$/.exec(markdown.split("\n", 1)[0])?.[1]?.trim() || "";
export const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const imagePath = new RegExp("^\\.\\./assets/(" + uuid + "\\.(?:png|jpg|webp))$");
export {
  breakBeforeHeading,
  closeFence,
  continueList,
  deleteMarker,
  findMatch,
  headingCaret,
  indentItem,
  insertLink,
  markerEnd,
  shortcutHelp,
  insertTaskAfter,
  removeTask,
  renameTask,
  spliceText,
  toggleTask,
  todoShortcut,
  toggleTaskAt,
  wrapSelection,
} from "./edit.ts";
export type { Span } from "./edit.ts";
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function client(
  origin: string,
  headers: Record<string, string> = {},
  send: typeof fetch = fetch,
) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const requestHeaders = new Headers(headers);
    new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
    const res = await send(origin + "/api/" + path, {
      ...init,
      redirect: "error",
      headers: requestHeaders,
    });
    const data = await res.json().catch(() => null);
    init?.signal?.throwIfAborted();
    if (!res.ok || !data)
      throw new ApiError(
        res.status,
        data?.error || "Request failed (" + res.status + "). Check your Access session.",
      );
    return data;
  }
  async function* readPages<T>(path: string, signal?: AbortSignal): AsyncGenerator<T[]> {
    let cursor = 0;
    while (true) {
      signal?.throwIfAborted();
      const page = await request<Page<T>>(
        path + (path.includes("?") ? "&" : "?") + "cursor=" + cursor,
        { signal },
      );
      if (
        !Array.isArray(page.items) ||
        (page.next !== null && (!Number.isSafeInteger(page.next) || page.next <= cursor))
      )
        throw new Error("Invalid document page.");
      yield page.items;
      if (page.next === null) return;
      cursor = page.next;
    }
  }
  const pages = (signal?: AbortSignal) => readPages<Summary>("docs", signal);
  return {
    pages,
    async list(signal?: AbortSignal): Promise<Summary[]> {
      const docs = new Map<string, Summary>();
      for await (const page of pages(signal)) for (const doc of page) docs.set(doc.id, doc);
      return [...docs.values()].sort((a, b) => a.title.localeCompare(b.title));
    },
    async search(query: string, signal?: AbortSignal, onPage?: (items: SearchResult[]) => void) {
      let items: SearchResult[] = [];
      for await (const page of readPages<SearchResult>(
        "search?q=" + encodeURIComponent(query),
        signal,
      )) {
        const merged = new Map([...items, ...page].map((item) => [item.id, item]));
        items = rankResults([...merged.values()]);
        onPage?.(items);
      }
      return { items };
    },
    get: (id: string, signal?: AbortSignal) =>
      request<Document>("docs/" + encodeURIComponent(id), { signal }),
    /**
     * `keepalive` lets a save started while the page is being hidden or closed finish. Browsers
     * reject keepalive bodies over 64 KiB, so larger documents fall back to an ordinary request.
     */
    save(
      markdown: string,
      base?: Pick<Document, "id" | "sha">,
      options: { keepalive?: boolean } = {},
    ) {
      const body = JSON.stringify({ markdown, sha: base?.sha });
      const keepalive = options.keepalive && new TextEncoder().encode(body).length <= 60 * 1024;
      return request<Document>(base ? "docs/" + encodeURIComponent(base.id) : "docs", {
        method: base ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "X-Descartes-Write": "1" },
        body,
        ...(keepalive ? { keepalive: true } : {}),
      });
    },
    attach: (file: File) =>
      request<{ path: string }>("assets", {
        method: "POST",
        headers: { "X-Descartes-Write": "1" },
        body: file,
      }),
  };
}
