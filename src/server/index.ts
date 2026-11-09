import { createApp } from "./app";

const port = Number(process.env.CUTROOM_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("CUTROOM_PORT must be a valid TCP port.");
const runtime = await createApp({
  port,
  allowDevOrigin: process.env.CUTROOM_DEV === "1",
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  fetch: runtime.app.fetch,
});
console.log(`Cutroom is ready at ${server.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.dispose();
  await server.stop(true);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
