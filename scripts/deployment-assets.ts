/** Compare the actual frontend, not merely an API that may belong to an older UI release. */
export function frontendAssets(html: string): string[] {
  const assets = new Set<string>();
  for (const match of html.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const path = match[1];
    if (!path.startsWith("/assets/")) continue;
    if (!/^\/assets\/(?:[\w-]+\/)*[\w.-]+\.(?:js|css)$/.test(path) || path.includes(".."))
      throw new Error("Invalid frontend asset path.");
    assets.add(path);
  }
  if (![...assets].some((asset) => asset.endsWith(".js")))
    throw new Error("No application assets found; the response may be a login page.");
  return [...assets].sort();
}

export function assertFrontendMatchesBuild(builtHtml: string, deployedHtml: string): string[] {
  const expected = frontendAssets(builtHtml);
  const actual = frontendAssets(deployedHtml);
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("The deployed frontend does not match the verified build.");
  return expected;
}
