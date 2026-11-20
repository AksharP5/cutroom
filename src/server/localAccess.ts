/**
 * Browsers supply Origin. The editor's own mutations must carry the workspace's exact Origin;
 * local MCP clients on `/mcp` may omit it, because a browser always sends one on a POST.
 */
export function allowsLocalRequest(
  request: Request,
  baseUrl: string,
  allowDevOrigin = false,
) {
  // Bun builds the URL from the Host header, so this also refuses DNS-rebinding names.
  const url = URL.parse(request.url);
  if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    return false;
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
  if (url.pathname === "/mcp")
    return origin === null || allowed.includes(origin);
  const read = ["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (!read) return origin !== null && allowed.includes(origin);
  if (!origin || allowed.includes(origin)) return true;
  return (
    origin === "null" && read && /^\/api\/isolated\/[\w-]+\//.test(url.pathname)
  );
}
