import { createApi } from "../apps/api/src/routes.ts";
import type { Repository } from "../apps/api/src/repository.ts";

// Exercise the real HTTP middleware with an explicit test-only storage resolver.
const app = createApi<Repository>((_req, store) => store);
export const route = (req: Request, store: Repository) => app.fetch(req, store);

type GraphqlBlob = { text: string | null; isBinary: boolean | null; isTruncated: boolean } | null;
/** Answers the adapter's aliased `object(oid:)` blob lookups like api.github.com/graphql. */
export function answerGraphql(
  init: RequestInit | undefined,
  blob: (sha: string) => string | GraphqlBlob,
) {
  const { variables } = JSON.parse(String(init?.body));
  const repository: Record<string, GraphqlBlob> = {};
  for (const [key, sha] of Object.entries(variables as Record<string, string>)) {
    if (!/^b\d+$/.test(key)) continue;
    const found = blob(sha);
    repository[key] =
      typeof found === "string" ? { text: found, isBinary: false, isTruncated: false } : found;
  }
  return Response.json({ data: { repository } });
}
export const blobLookups = (init: RequestInit | undefined) =>
  Object.keys(JSON.parse(String(init?.body)).variables).filter((key) => /^b\d+$/.test(key));
