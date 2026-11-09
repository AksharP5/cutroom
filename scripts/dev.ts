export {};

const children = [
  Bun.spawn(["bun", "--watch", "src/server/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, CUTROOM_DEV: "1" },
  }),
  Bun.spawn(["bun", "node_modules/vite/bin/vite.js"], {
    stdout: "inherit",
    stderr: "inherit",
  }),
];

function stop() {
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(children.map((child) => child.exited));
stop();
