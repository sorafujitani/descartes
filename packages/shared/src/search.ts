import type { SearchResult } from "./index.ts";

export const normalizeSearch = (text: string) => text.normalize("NFKC").toLowerCase();
export function searchTerms(query: string) {
  return normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
}

/** All terms must match; titles rank ahead of body-only matches. */
export function matchDocument(
  id: string,
  title: string,
  markdown: string,
  terms: string[],
): SearchResult | undefined {
  if (!terms.length) return;
  const heading = normalizeSearch(title);
  const body = normalizeSearch(markdown);
  if (!terms.every((term) => body.includes(term) || heading.includes(term))) return;
  const lines = markdown.split("\n");
  const line = lines
    .slice(1)
    .find((line) => terms.some((term) => normalizeSearch(line).includes(term)));
  return {
    id,
    title,
    snippet: (line ?? lines.slice(1).find((line) => line.trim()) ?? "").trim().slice(0, 200),
    rank: terms.every((term) => heading.includes(term)) ? 0 : 1,
  };
}
export function rankResults(results: SearchResult[], limit = 50) {
  return results
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .slice(0, limit);
}
