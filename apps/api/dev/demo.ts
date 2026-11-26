// Separate entrypoint: no secrets, GitHub access, or persistent storage.
import {
  titleOf,
  matchDocument,
  rankResults,
  searchTerms,
  type Document,
  type SearchResult,
} from "@descartes/shared";
import { fail, type Repository } from "../src/repository.ts";
import { createApi } from "../src/routes.ts";
export function memoryStore(): Repository {
  const docs = new Map<string, Document>(),
    images = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    // The demo has no remote repository, so every check passes, fresh or not.
    async privateOnly(_options?: { fresh?: boolean }) {},
    async list(cursor) {
      // Like the GitHub adapter with known titles: the whole list in one page.
      const items = Array.from(docs.values(), ({ id, title }) => ({ id, title }));
      return { items: items.slice(cursor), next: null };
    },
    async search(query, cursor = 0) {
      const terms = searchTerms(query);
      const page = [...docs.values()].slice(cursor, cursor + 32);
      return {
        items: rankResults(
          page
            .map((doc) => matchDocument(doc.id, doc.title, doc.markdown, terms))
            .filter((result): result is SearchResult => result !== undefined),
        ),
        next: cursor + page.length < docs.size ? cursor + page.length : null,
      };
    },
    async get(id) {
      return docs.get(id) ?? fail(404, "Not found.");
    },
    async save(id, markdown, sha) {
      if (docs.get(id)?.sha !== sha)
        fail(409, "保存が競合しました。下書きをコピーして最新版を開いてください。");
      const version = Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("");
      const doc = { id, markdown, title: titleOf(markdown), sha: version };
      docs.set(id, doc);
      return doc;
    },
    async asset(name) {
      return new Response(images.get(name) ?? fail(404, "Not found."));
    },
    async attach(name, bytes) {
      images.set(name, new Uint8Array(bytes));
      return { path: "../assets/" + name };
    },
  };
}
const store = memoryStore();
const app = createApi<Repository>((req, repository) => {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(req.url).hostname))
    fail(403, "Demo is available only on loopback.");
  return repository;
});
export default { fetch: (req: Request) => app.fetch(req, store) };
