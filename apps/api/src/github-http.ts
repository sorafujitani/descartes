import { fail } from "./repository.ts";

export type GitHubRequest = (url: string, init?: RequestInit, raw?: boolean) => Promise<Response>;
export type GitHubCall = (path: string, init?: RequestInit, raw?: boolean) => Promise<Response>;

/**
 * Authenticated GitHub client: `request` takes an absolute URL, `call` a path in the repository.
 * GitHub failures are mapped to user-facing HTTP errors.
 */
export function githubHttp(
  env: { GITHUB_REPOSITORY: string; GITHUB_TOKEN: string },
  send: typeof fetch,
): { request: GitHubRequest; call: GitHubCall } {
  const root = "https://api.github.com/repos/" + env.GITHUB_REPOSITORY;
  const request: GitHubRequest = async (url, init, raw = false) => {
    const res = await send(url, {
      ...init,
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers: {
        Authorization: "Bearer " + env.GITHUB_TOKEN,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "User-Agent": "descartes",
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (res.status === 409 || (res.status === 422 && init?.method === "PUT"))
      fail(409, "保存が競合しました。下書きをコピーして最新版を開いてください。");
    if (res.status === 404) fail(404, "文書またはリポジトリが見つかりません。");
    if (!res.ok && res.status !== 304) fail(502, "GitHub request failed (" + res.status + ").");
    return res;
  };
  return { request, call: (path, init, raw) => request(root + path, init, raw) };
}

/**
 * Reads blob texts in one GraphQL request. `undefined` marks a blob GraphQL cannot serve
 * (binary, truncated or missing), which must be read from the REST blob endpoint instead.
 */
export async function graphqlBlobs(
  request: GitHubRequest,
  repository: string,
  shas: string[],
): Promise<(string | undefined)[]> {
  const [owner, name] = repository.split("/");
  const query = `query($owner: String!, $name: String!, ${shas
    .map((_, i) => `$b${i}: GitObjectID!`)
    .join(", ")}) { repository(owner: $owner, name: $name) { ${shas
    .map((_, i) => `b${i}: object(oid: $b${i}) { ... on Blob { text isBinary isTruncated } }`)
    .join(" ")} } }`;
  const variables: Record<string, string> = { owner, name };
  shas.forEach((sha, i) => (variables["b" + i] = sha));
  const res = await request("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    fail(502, "GitHub request failed.");
  }
  // Rate limits and permission problems arrive as 200 with `errors`; their text is never forwarded.
  const found = data?.errors?.length ? undefined : data?.data?.repository;
  if (!found) fail(502, "GitHub request failed.");
  return shas.map((_, i) => {
    const blob = found["b" + i];
    if (blob?.isBinary !== false || blob.isTruncated !== false || typeof blob.text !== "string")
      return undefined;
    // The REST path decodes with TextDecoder, which drops a UTF-8 BOM; keep both paths identical.
    return (blob.text as string).replace(/^\uFEFF/, "");
  });
}

export function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export const decode = (str: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(str), (c) => c.charCodeAt(0)));
