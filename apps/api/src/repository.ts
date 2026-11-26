import type { Document, Page, SearchResult, Summary } from "@descartes/shared";

/** Storage boundary shared by the authenticated Worker and the loopback demo. */
export interface Repository {
  /** Rejects unless the repository is private; `fresh` bypasses any cached confirmation (writes). */
  privateOnly(options?: { fresh?: boolean }): Promise<void>;
  list(cursor: number): Promise<Page<Summary>>;
  search(query: string, cursor?: number): Promise<Page<SearchResult>>;
  get(id: string): Promise<Document>;
  save(id: string, markdown: string, sha?: string): Promise<Document>;
  asset(name: string): Promise<Response>;
  attach(name: string, bytes: Uint8Array): Promise<{ path: string }>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
