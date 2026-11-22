// Read-only production smoke test. Reuse the native client's scoped Access credentials without logging them.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertFrontendMatchesBuild } from "./deployment-assets.ts";

let credentials;
try {
  credentials = JSON.parse(
    await readFile(join(homedir(), ".config/descartes/desktop-access.json"), "utf8"),
  );
} catch {
  throw new Error("Desktop Access configuration is unavailable or invalid.");
}
let origin;
try {
  origin = new URL(credentials.origin);
} catch {
  throw new Error("Invalid desktop API origin.");
}
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  !["", "/"].includes(origin.pathname)
)
  throw new Error("Invalid desktop API origin.");
if (!credentials.client_id || !credentials.client_secret)
  throw new Error("Desktop Access credentials are missing.");
const headers = {
  "CF-Access-Client-Id": credentials.client_id,
  "CF-Access-Client-Secret": credentials.client_secret,
};
const report = [];
async function request(path) {
  return fetch(new URL(path, origin), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
}
const buildRoot = new URL(
  "../apps/web/.cloudflare/output/v1/workers/default/assets/",
  import.meta.url,
);
let builtHtml;
try {
  builtHtml = await readFile(new URL("index.html", buildRoot), "utf8");
} catch {
  throw new Error("Build the production frontend before verifying its deployment.");
}
const frontend = await request("/");
if (frontend.status !== 200) throw new Error(`Frontend access failed (HTTP ${frontend.status}).`);
const assets = assertFrontendMatchesBuild(builtHtml, await frontend.text());
for (const asset of assets) {
  const response = await request(asset);
  if (response.status !== 200) throw new Error(`Frontend asset failed (HTTP ${response.status}).`);
  const builtBytes = await readFile(new URL("." + asset, buildRoot));
  if (!builtBytes.equals(Buffer.from(await response.arrayBuffer())))
    throw new Error("Deployed frontend asset bytes do not match the verified build.");
}
report.push({ operation: "frontend", status: 200, verifiedAssets: assets.length });
async function get(path, operation) {
  const start = performance.now();
  const response = await request(path);
  const timing = response.headers.get("Server-Timing");
  report.push({
    operation,
    status: response.status,
    roundTripMs: Math.round(performance.now() - start),
    serverTiming: timing,
  });
  if (response.status !== 200)
    throw new Error(
      `${operation} failed (HTTP ${response.status}); no response content was logged.`,
    );
  if (!timing?.includes("total;dur="))
    throw new Error("The timing-enabled deployment is not active.");
  if (response.headers.get("Cache-Control") !== "private, no-store")
    throw new Error("API response is not private/no-store.");
  return response.json();
}

const list = await get("/api/docs?cursor=0", "list");
if (!Array.isArray(list.items)) throw new Error("Invalid title page.");
if (list.items[0]) {
  const doc = await get("/api/docs/" + encodeURIComponent(list.items[0].id), "read");
  if (
    doc.id !== list.items[0].id ||
    !/^[a-f0-9]{40}$/.test(doc.sha) ||
    typeof doc.markdown !== "string"
  )
    throw new Error("Invalid document response.");
}
const query = "descartes-smoke-" + crypto.randomUUID();
let cursor = 0;
let pages = 0;
for (;;) {
  const page = await get(
    "/api/search?q=" + encodeURIComponent(query) + "&cursor=" + cursor,
    "search",
  );
  if (!Array.isArray(page.items)) throw new Error("Invalid search page.");
  if (page.next === null) break;
  if (!Number.isSafeInteger(page.next) || page.next <= cursor || ++pages > 1000)
    throw new Error("Invalid search cursor.");
  cursor = page.next;
}
await get("/api/search?q=" + encodeURIComponent(query), "search-indexed");
const unauthenticated = await fetch(new URL("/api/docs", origin), {
  redirect: "manual",
  signal: AbortSignal.timeout(20_000),
});
if (![301, 302, 303, 307, 308, 401, 403].includes(unauthenticated.status))
  throw new Error("Unauthenticated document access was not denied.");
await unauthenticated.body?.cancel();
console.log(
  JSON.stringify(
    { readOnly: true, results: report, unauthenticatedStatus: unauthenticated.status },
    null,
    2,
  ),
);
