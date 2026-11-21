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
const socket = importSocketPath(`http://127.0.0.1:${port}`);
const socketDir = await openImportSocket(socket, true);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  // The upload route accepts 500 MB of media per request; leave room for multipart framing.
  maxRequestBodySize: 512 * 1024 * 1024,
  fetch: runtime.app.fetch,
});
let imports: ReturnType<typeof Bun.serve>;
try {
  // Owning the TCP port also means no other Cutroom server owns this port's socket.
  const stale = lstatSync(socketDir.address, { throwIfNoEntry: false });
  if (stale) {
    if (!stale.isSocket() || stale.uid !== process.getuid?.())
      throw new Error("Cutroom's media import socket path is occupied.");
    unlinkSync(socketDir.address);
  }
  imports = Bun.serve({
    unix: socketDir.address,
    fetch(request, server) {
      server.timeout(request, 0);
      return runtime.mediaImport.fetch(request);
    },
  });
} catch (error) {
  await server.stop(true);
  await socketDir.handle.close();
  await runtime.dispose();
  throw error;
}
console.log(`Cutroom is ready at ${server.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await runtime.dispose();
  } finally {
    await imports.stop(true);
    try {
      unlinkSync(socketDir.address);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) console.error(error);
    }
    await socketDir.handle.close();
    await server.stop(true);
    if (process.connected) process.disconnect();
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
