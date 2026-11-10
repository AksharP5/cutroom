/** Browsers supply Origin; native clients must send the workspace's exact Origin explicitly. */
export function allowsLocalRequest(
  request: Request,
  baseUrl: string,
  allowDevOrigin = false,
) {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  // Opaque frames can navigate without Origin and discard their document's CSP.
  if (
    request.headers.get("sec-fetch-site") === "cross-site" &&
    !url.pathname.startsWith("/api/isolated/")
  )
    return false;
  const port = new URL(baseUrl).port;
  const allowed = [baseUrl, `http://localhost:${port}`];
  if (allowDevOrigin)
    allowed.push("http://127.0.0.1:5173", "http://localhost:5173");
  const origin = request.headers.get("origin");
  const read = ["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (!read) return origin !== null && allowed.includes(origin);
  if (!origin || allowed.includes(origin)) return true;
  return (
    origin === "null" &&
    ["GET", "HEAD"].includes(request.method) &&
    /^\/api\/isolated\/[\w-]+\//.test(url.pathname)
  );
}
