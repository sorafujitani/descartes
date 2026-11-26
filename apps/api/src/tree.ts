import { uuid } from "@descartes/shared";
import { HttpError, fail } from "./repository.ts";
import type { GitHubCall } from "./github-http.ts";
import type { IndexEntry } from "./search-index.ts";
import { SingleFlight } from "./single-flight.ts";

/** A document of the current tree; `size` is the blob size in bytes when GitHub reports it. */
export type Entry = IndexEntry & { size?: number };
const docPath = new RegExp("^docs/(" + uuid + ")\\.md$");
const TREE_TTL = 15_000;

/**
 * Sorted documents of the branch's docs/ subtree, revalidated by ETag after a short TTL.
 * `invalidate` bumps a generation so reads started before a write never publish their stale tree.
 */
export function documentTree(
  call: GitHubCall,
  branch: string,
  now: () => number,
  /** Runs after a full (non-304) listing that is still current, before it is published. */
  fetched: (entries: Entry[]) => Promise<unknown>,
) {
  // Only the docs subtree is listed, so screenshots in assets/ can never make the tree truncate.
  const docsTree = "/git/trees/" + encodeURIComponent(branch + ":docs");
  let tree: { entries: Entry[]; etag?: string; expires: number } | undefined;
  let generation = 0;
  const loading = new SingleFlight<"tree", Entry[], number>();
  return {
    invalidate() {
      generation++;
      tree = undefined;
    },
    async read(): Promise<Entry[]> {
      if (tree && tree.expires > now()) return tree.entries;
      const version = generation;
      const previous = tree;
      return loading.run("tree", version, async () => {
        let response: Response | undefined;
        try {
          response = await call(docsTree, {
            headers: previous?.etag ? { "If-None-Match": previous.etag } : {},
          });
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 404) throw error;
          // A missing branch and a branch without docs/ both 404; only the latter is an empty notebook.
          await call("/git/trees/" + encodeURIComponent(branch));
        }
        let entries: Entry[];
        if (response?.status === 304 && previous) entries = previous.entries;
        else {
          const data = response ? await response.json() : { tree: [] };
          if (data.truncated) fail(503, "Repository tree is too large.");
          entries = [];
          for (const f of data.tree as {
            path: string;
            sha: string;
            type: string;
            size?: number;
          }[]) {
            const id = f.type === "blob" && docPath.exec("docs/" + f.path)?.[1];
            if (id) entries.push({ id, sha: f.sha, size: f.size });
          }
          entries.sort((a, b) => a.id.localeCompare(b.id));
          if (version === generation) await fetched(entries);
        }
        if (version === generation) {
          tree = {
            entries,
            etag:
              response?.headers.get("ETag") ??
              (response?.status === 304 ? previous?.etag : undefined),
            expires: now() + TREE_TTL,
          };
        }
        return entries;
      });
    },
  };
}
