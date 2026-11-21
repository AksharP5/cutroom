import { lstatSync, unlinkSync } from "node:fs";
import {
  hasCode,
  importSocketPath,
  openImportSocket,
} from "../local/mediaImport";
import { createApp } from "./app";

// Register before startup so quitting the desktop during initialization is remembered.
const desktopClosed = process.connected
  ? new Promise<void>((resolve) => process.once("disconnect", resolve))
  : undefined;
const port = Number(process.env.CUTROOM_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("CUTROOM_PORT must be a valid TCP port.");
const runtime = await createApp({
  port,
  allowDevOrigin: process.env.CUTROOM_DEV === "1",
});
const socket = importSocketPath(`http://127.0.0.1:${port}`, runtime.dataDir);
const socketDir = await openImportSocket(socket, true).catch(
  (error: unknown) => {
    console.warn("Local media import is unavailable:", error);
  },
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  // The upload route accepts 500 MB of media per request; leave room for multipart framing.
  maxRequestBodySize: 512 * 1024 * 1024,
  fetch: runtime.app.fetch,
});
const stopImports = socketDir && listenForImports(socketDir);

function listenForImports({
  address,
  handle,
}: Awaited<ReturnType<typeof openImportSocket>>) {
  try {
    // Owning the TCP port also means no other Cutroom server owns this port's socket.
    const stale = lstatSync(address, { throwIfNoEntry: false });
    if (stale) {
      if (!stale.isSocket() || stale.uid !== process.getuid?.())
        throw new Error("Cutroom's media import socket path is occupied.");
      unlinkSync(address);
    }
    const imports = Bun.serve({
      unix: address,
      fetch(request, server) {
        server.timeout(request, 0);
        return runtime.mediaImport.fetch(request);
      },
    });
    return async () => {
      try {
        await imports.stop(true);
        unlinkSync(address);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) console.warn(error);
      } finally {
        await handle.close();
      }
    };
  } catch (error) {
    console.warn("Local media import is unavailable:", error);
    void handle.close().catch(console.warn);
  }
}
console.log(`Cutroom is ready at ${server.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await runtime.dispose();
  } finally {
    try {
      await stopImports?.();
    } finally {
      await server.stop(true);
      if (process.connected) process.disconnect();
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void stop().catch((error: unknown) => {
      console.error("Cutroom could not close cleanly:", error);
      process.exitCode = 1;
    });
  });
if (desktopClosed)
  void desktopClosed.then(stop).catch((error: unknown) => {
    console.error("Cutroom could not close after the desktop exited:", error);
    process.exitCode = 1;
  });
