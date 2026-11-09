import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function localServerUrl(rawPort = "4317") {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("CUTROOM_PORT must be a valid TCP port.");
  return `http://127.0.0.1:${port}`;
}

export function isApplicationUrl(value: string, baseUrl: string) {
  try {
    return new URL(value).origin === baseUrl;
  } catch {
    return false;
  }
}

async function health(baseUrl: string) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(700),
    });
  } catch {
    return false;
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      "Another application is using Cutroom's port. Set CUTROOM_PORT to an available port.",
    );
  }
  if (
    !response.ok ||
    !value ||
    typeof value !== "object" ||
    !("app" in value) ||
    value.app !== "cutroom" ||
    !("ok" in value) ||
    value.ok !== true
  ) {
    throw new Error(
      "Another application is using Cutroom's port. Set CUTROOM_PORT to an available port.",
    );
  }
  return true;
}

/** The desktop owns only the server process it started; an existing workspace keeps running. */
export async function connectLocalServer(options: {
  root: string;
  runtimeBin?: string;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
}) {
  if (await health(options.baseUrl))
    return { owned: false, stop: async () => {} };
  const env = options.env ?? process.env;
  const bundledBun =
    options.runtimeBin &&
    join(options.runtimeBin, process.platform === "win32" ? "bun.exe" : "bun");
  const bun =
    env.CUTROOM_BUN_PATH ||
    (bundledBun && existsSync(bundledBun) ? bundledBun : "bun");
  const child = spawn(bun, [join(options.root, "src/server/index.ts")], {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      CUTROOM_PORT: new URL(options.baseUrl).port,
      CUTROOM_URL: options.baseUrl,
      ...(options.runtimeBin
        ? { PATH: `${options.runtimeBin}${delimiter}${env.PATH ?? ""}` }
        : {}),
      HYPERFRAMES_NO_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
    },
  });
  let startupError: Error | undefined;
  let diagnostics = "";
  child.on("error", (error) => {
    startupError = error;
  });
  const record = (bytes: Buffer) => {
    diagnostics = (diagnostics + bytes.toString()).slice(-8000);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  let stopped = false;
  const stop = async () => {
    if (
      stopped ||
      !child.pid ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    stopped = true;
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 6000);
    await exited;
    clearTimeout(timeout);
  };
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (startupError)
        throw new Error(`Cutroom could not start Bun: ${startupError.message}`);
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          diagnostics.trim() || "The local editor stopped before it was ready.",
        );
      if (await health(options.baseUrl)) return { owned: true, stop };
      await new Promise((done) => setTimeout(done, 80));
    }
    throw new Error(
      diagnostics.trim() || "The local editor did not start within 20 seconds.",
    );
  } catch (error) {
    await stop();
    throw error;
  }
}
