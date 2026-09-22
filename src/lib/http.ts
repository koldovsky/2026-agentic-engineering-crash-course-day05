import { ZodError } from "zod";
import { MAX_FILE_BYTES } from "./schema";
import { DatasetLimitError, ImportConflictError } from "./storage";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// The hosted demo (Vercel, or TOKEN_ATLAS_PUBLIC_DEMO=1) is reached through a public host name, so the
// loopback rule is lifted there; the same-origin checks below still apply to every mutation.
const HOSTED_DEMO = process.env.VERCEL === "1" || process.env.TOKEN_ATLAS_PUBLIC_DEMO === "1";

export function assertLocalRequest(request: Request, mutation = false) {
  const host = request.headers.get("host") ?? "";
  if (!HOSTED_DEMO && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) throw new HttpError(403, "This app accepts localhost requests only.");
  const protocol = new URL(request.url).protocol;
  const expectedOrigin = `${protocol}//${host}`.toLowerCase();
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin && origin.toLowerCase() !== expectedOrigin) || (mutation && !origin)) {
    throw new HttpError(403, "Use the dashboard on the same localhost origin.");
  }
  if (mutation && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Send a JSON request.");
  }
}

export async function readJsonRequest(request: Request): Promise<unknown> {
  assertLocalRequest(request, true);
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_FILE_BYTES) throw new HttpError(413, "File exceeds the 20 MiB request limit.");
  if (!request.body) throw new HttpError(400, "Choose a file or provide a request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new HttpError(413, "File exceeds the 20 MiB request limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HttpError(400, "The file or request is not valid UTF-8 JSON."); }
}

export function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function apiResponse(action: () => unknown | Promise<unknown>): Promise<Response> {
  try { const result = await action(); return result instanceof Response ? result : jsonResponse(result); }
  catch (error) {
    if (error instanceof HttpError) return jsonResponse({ error: error.message }, error.status);
    if (error instanceof ImportConflictError) return jsonResponse({ error: error.message }, 409);
    if (error instanceof DatasetLimitError) return jsonResponse({ error: error.message }, 413);
    if (error instanceof ZodError) return jsonResponse({ error: "Invalid file or filters. Check schema version, fields, dates, identities and token counts." }, 400);
    return jsonResponse({ error: "The local data could not be processed. Check file permissions and try again." }, 500);
  }
}
