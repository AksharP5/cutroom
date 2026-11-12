import { mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { desktopPermission } from "./permissions";
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
      preload: resolve(
        app.getAppPath(),
        app.isPackaged ? "desktop/preload.cjs" : "preload.cjs",
      ),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: "user-gesture-required",
    },
  });
  const fromCutroom = (event: IpcMainInvokeEvent) =>
    event.sender === window?.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    isApplicationUrl(event.senderFrame.url, baseUrl);
  ipcMain.handle("cutroom:reveal", async (event, value: unknown) => {
    if (!fromCutroom(event)) throw new Error("Only Cutroom can reveal a file.");
    // Showing a file opens nothing; a missing one is refused here by name.
    shell.showItemInFolder(
      await realpath(z.string().refine(isAbsolute).parse(value)),
    );
  });
  ipcMain.handle("cutroom:export-file", async (event, value: unknown) => {
    if (!fromCutroom(event))
      throw new Error("Only Cutroom can open an export.");
    const input = z
      .object({
        path: z.string().refine(isAbsolute),
        action: z.enum(["open", "reveal"]),
      })
      .parse(value);
    const path = await realpath(input.path);
    if (!path.toLowerCase().endsWith(".mp4") || !(await stat(path)).isFile())
      throw new Error("Choose an exported MP4 file.");
    if (input.action === "reveal") {
      shell.showItemInFolder(path);
      return;
    }
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  window.webContents.setAudioMuted(process.env.CUTROOM_MUTE_AUDIO === "1");
  window.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback, details) =>
      callback(
        desktopPermission(
          permission,
          details.requestingUrl,
          baseUrl,
          details.isMainFrame,
          "mediaTypes" in details ? details.mediaTypes : [],
        ),
      ),
  );
  window.webContents.session.setPermissionCheckHandler(
    (_contents, permission, origin, details) =>
      desktopPermission(
        permission,
        details.requestingUrl ?? origin,
        baseUrl,
        details.isMainFrame,
        details.mediaType ? [details.mediaType] : [],
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
  window.webContents.on("will-prevent-unload", () => {
    if (!window) return;
    void dialog.showMessageBox(window, {
      type: "info",
      message: "Save or discard the voiceover take before closing Cutroom.",
      buttons: ["Return to take"],
    });
  });
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
    if (window) {
      window.close();
      return;
    }
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
