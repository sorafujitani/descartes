import { Hono } from "hono";
import { titleOf, uuid } from "@descartes/shared";
import { body, errorResponse, imageType, json } from "./http.ts";
import { fail, type Repository } from "./repository.ts";
import { operationOf, RequestMetrics, type RequestReport } from "./metrics.ts";

const validId = new RegExp("^" + uuid + "$");
const validImage = new RegExp("^" + uuid + "\\.(png|jpg|webp)$");
function cursorOf(raw = "0") {
  if (!/^\d+$/.test(raw)) fail(400, "Invalid cursor.");
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor)) fail(400, "Invalid cursor.");
  return cursor;
}

/** The resolver is the only environment-specific part; demo and production use identical routes. */
export function createApi<Bindings extends object>(
  resolve: (req: Request, env: Bindings) => Promise<Repository> | Repository,
  options: { report?: (report: RequestReport) => void } = {},
) {
  const app = new Hono<{
    Bindings: Bindings;
    Variables: { store: Repository; metrics: RequestMetrics };
  }>({ strict: true });
  app.onError(errorResponse);
  app.use("*", async (c, next) => {
    const metrics = new RequestMetrics();
    const requestId = crypto.randomUUID();
    c.set("metrics", metrics);
    try {
      await next();
    } finally {
      c.header("Server-Timing", metrics.finish());
      c.header("X-Request-ID", requestId);
      // Never log paths, query strings, titles, bodies, credentials or upstream exception messages.
      try {
        options.report?.({
          event: "api_request",
          requestId,
          operation: operationOf(new URL(c.req.url).pathname, c.req.method),
          method: c.req.method,
          status: c.res.status,
          timings: metrics.timings,
        });
      } catch {
        /* Telemetry cannot fail a save. */
      }
    }
  });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    const req = c.req.raw;
    const store = await c.get("metrics").measure("auth", () => resolve(req, c.env));
    const read = req.method === "GET" || req.method === "HEAD";
    if (
      !read &&
      (req.headers.get("X-Descartes-Write") !== "1" ||
        (req.headers.has("Origin") && req.headers.get("Origin") !== new URL(req.url).origin))
    )
      fail(403, "Invalid write origin.");
    const privacy = c.get("metrics").measure("privacy", () => store.privateOnly());
    c.set("store", store);
    if (!read) {
      // Nothing may be written to a repository that has not been confirmed private.
      await privacy;
      await next();
      return;
    }
    // Reads overlap the privacy round trip, but no response leaves before it succeeds.
    privacy.catch(() => {});
    await next();
    await privacy;
  });
  app.get("/api/docs", async (c) => {
    const cursor = cursorOf(c.req.query("cursor"));
    const page = await c.get("metrics").measure("list", () => c.get("store").list(cursor));
    if (cursor !== 0 || page.next !== null) return json(page);
    // A complete list carries a validator, so an unchanged list costs an empty 304.
    const body = JSON.stringify(page);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const etag =
      '"' +
      Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("") +
      '"';
    const headers = {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ETag: etag,
    };
    if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers });
    return new Response(body, {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  });
  app.get("/api/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (query.length > 200) fail(400, "Search query is too long.");
    const cursor = cursorOf(c.req.query("cursor"));
    return json(
      query
        ? await c.get("metrics").measure("search", () => c.get("store").search(query, cursor))
        : { items: [], next: null },
    );
  });
  app.get("/api/docs/:id", async (c) => {
    const id = c.req.param("id");
    if (!validId.test(id)) fail(404, "Not found.");
    return json(await c.get("metrics").measure("read", () => c.get("store").get(id)));
  });
  async function save(req: Request, store: Repository, id?: string) {
    if (id && !validId.test(id)) fail(404, "Not found.");
    const bytes = await body(req, 768 * 1024);
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      fail(400, "Invalid JSON.");
    }
    if (typeof data?.markdown !== "string" || !titleOf(data.markdown))
      fail(400, "1行目に「# タイトル」を入力してください。");
    if (id && (typeof data.sha !== "string" || !/^[a-f0-9]{40}$/.test(data.sha)))
      fail(400, "Missing version.");
    return json(
      await store.save(id ?? crypto.randomUUID(), data.markdown, id ? data.sha : undefined),
      id ? 200 : 201,
    );
  }
  app.post("/api/docs", (c) =>
    c.get("metrics").measure("save", () => save(c.req.raw, c.get("store"))),
  );
  app.put("/api/docs/:id", (c) =>
    c.get("metrics").measure("save", () => save(c.req.raw, c.get("store"), c.req.param("id"))),
  );
  app.post("/api/assets", async (c) => {
    const bytes = await body(c.req.raw, 4 * 1024 * 1024);
    return json(
      await c.get("store").attach(crypto.randomUUID() + "." + imageType(bytes), bytes),
      201,
    );
  });
  app.get("/api/assets/:name", async (c) => {
    const name = c.req.param("name");
    const image = validImage.exec(name);
    if (!image) fail(404, "Not found.");
    const r = await c.get("store").asset(name);
    return new Response(r.body, {
      headers: {
        "Content-Type": image[1] === "jpg" ? "image/jpeg" : "image/" + image[1],
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  });
  app.notFound(() => json({ error: "Not found." }, 404));
  return app;
}
