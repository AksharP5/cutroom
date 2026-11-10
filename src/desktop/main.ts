import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import {
  connectLocalServer,
  isApplicationUrl,
  localServerUrl,
} from "./runtime";

app.setName("Cutroom");
if (process.platform === "linux")
  app.setDesktopName("io.github.AksharP5.Cutroom.desktop");
const dataDir = resolve(
  process.env.CUTROOM_DATA_DIR || join(homedir(), ".local", "share", "cutroom"),
);
const userData = join(dataDir, "desktop");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
if (process.env.CUTROOM_NO_SANDBOX === "1")
  app.commandLine.appendSwitch("no-sandbox");

let window: BrowserWindow | undefined;
let server: Awaited<ReturnType<typeof connectLocalServer>> | undefined;
let quitting = false;
const lifetime = new AbortController();
let startup: Promise<void> | undefined;

function openExternal(url: string) {
  try {
    if (["https:", "http:"].includes(new URL(url).protocol))
      void shell
        .openExternal(url)
        .catch((error: unknown) =>
          console.error("The link could not be opened:", error),
        );
  } catch {
    /* Invalid links do not leave the editor. */
  }
}

async function start() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const root = resolve(process.env.CUTROOM_ROOT || app.getAppPath());
  const baseUrl = localServerUrl(process.env.CUTROOM_PORT);
  const runtimeBin = app.isPackaged
    ? join(process.resourcesPath, "runtime", "bin")
    : undefined;
  server = await connectLocalServer({
    root,
    baseUrl,
    runtimeBin,
    signal: lifetime.signal,
  });
  if (quitting) return;
  window = new BrowserWindow({
    title: "Cutroom",
    width: 1640,
    height: 1040,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    show: false,
    icon: join(root, "src", "desktop", "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: "user-gesture-required",
    },
  });
  window.webContents.setAudioMuted(process.env.CUTROOM_MUTE_AUDIO === "1");
  const permissionAllowed = (
    permission: string,
    url: string,
    mainFrame: boolean,
  ) =>
    isApplicationUrl(url, baseUrl) &&
    (permission === "fullscreen" ||
      (permission === "clipboard-sanitized-write" && mainFrame));
  window.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback, details) =>
      callback(
        permissionAllowed(
          permission,
          details.requestingUrl,
          details.isMainFrame,
        ),
      ),
  );
  window.webContents.session.setPermissionCheckHandler(
    (_contents, permission, origin, details) =>
      permissionAllowed(
        permission,
        details.requestingUrl ?? origin,
        details.isMainFrame,
      ),
  );
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isApplicationUrl(url, baseUrl)) return;
    event.preventDefault();
    openExternal(url);
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = undefined;
  });
  await window.loadURL(baseUrl);
  if (process.env.CUTROOM_DESKTOP_DEBUG === "1")
    window.webContents.openDevTools({ mode: "detach" });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    lifetime.abort();
    void (async () => {
      await startup;
      await server?.stop();
    })()
      .catch((error: unknown) =>
        console.error("Cutroom could not close cleanly:", error),
      )
      .finally(() => app.quit());
  });
  startup = start().catch((error: unknown) => {
    if (quitting) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    dialog.showErrorBox("Cutroom could not open", message);
    app.quit();
  });
}
