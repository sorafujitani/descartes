import { fail, HttpError } from "./repository.ts";

export const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
export const errorResponse = (error: unknown) =>
  json(
    { error: error instanceof HttpError ? error.message : "Request failed." },
    error instanceof HttpError ? error.status : 502,
  );
export async function body(req: Request, limit: number) {
  const declared = Number(req.headers.get("Content-Length"));
  if (declared > limit) fail(413, "File is too large.");
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        fail(413, "File is too large.");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
export function imageType(b: Uint8Array) {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)) return "png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpg";
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP"
  )
    return "webp";
  return fail(415, "PNG、JPEG、WebPの画像を選んでください。");
}
