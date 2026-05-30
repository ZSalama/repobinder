import { ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions } from "electron";

const DEFAULT_PORT = 3774;
const LOCALHOST = "127.0.0.1";
const REMOTE_HOST = "0.0.0.0";
const READY_TIMEOUT_MS = 15_000;

type BackendConfig = {
  host: string;
  localUrl: URL;
  port: number;
  remoteEnabled: boolean;
};

let backendProcess: ChildProcess | undefined;
let backendRestartTimer: NodeJS.Timeout | undefined;
let isQuitting = false;
let mainWindow: BrowserWindow | undefined;
let currentConfig: BackendConfig | undefined;
const desktopToken = crypto.randomUUID();
const intentionalBackendStops = new WeakSet<ChildProcess>();

app.setName("RepoBinder");
process.env.REPOBINDER_DESKTOP_TOKEN = desktopToken;

ipcMain.handle("repobinder:pick-folder", async () => {
  const options: OpenDialogOptions = {
    title: "Choose a Repository",
    properties: ["openDirectory"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("repobinder:get-desktop-context", () => ({
  platform: process.platform,
  desktopAuthToken: desktopToken,
}));

ipcMain.handle("repobinder:set-remote-mode", async (_event, enabled: unknown) => {
  if (typeof enabled !== "boolean") {
    throw new Error("Remote mode must be enabled or disabled");
  }

  const config = await applyRemoteMode(enabled);

  return {
    host: config.host,
    port: config.port,
    remoteEnabled: config.remoteEnabled,
  };
});

// Open Dev copies the Worktree's Dev Server URL from the desktop shell.
// Only loopback URLs are accepted so repository scripts cannot turn RepoBinder
// into an arbitrary clipboard writer.
ipcMain.handle("repobinder:copy-dev-server-url", (_event, url: unknown) => {
  if (typeof url !== "string" || !isLoopbackUrl(url)) {
    return false;
  }

  try {
    clipboard.writeText(url);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
});

app.whenReady().then(startDesktopApp).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  void stopBackend();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && currentConfig) {
    mainWindow = createWindow(currentConfig.localUrl.href);
  }
});

async function startDesktopApp(): Promise<void> {
  const remoteEnabled = await getInitialRemoteMode();
  const host = getBindHost(remoteEnabled);
  const port = await findAvailablePort(getPreferredPort(), host);
  const localUrl = new URL(`http://${LOCALHOST}:${port}`);

  currentConfig = {
    host,
    localUrl,
    port,
    remoteEnabled,
  };

  backendProcess = startBackend(currentConfig);
  await waitForHttpReady(new URL("/health", localUrl).href, READY_TIMEOUT_MS);
  mainWindow = createWindow(localUrl.href);

  logExposure(currentConfig);
}

async function applyRemoteMode(remoteEnabled: boolean): Promise<BackendConfig> {
  const host = getBindHost(remoteEnabled);

  if (currentConfig && currentConfig.host === host && currentConfig.remoteEnabled === remoteEnabled) {
    return currentConfig;
  }

  const preferredPort = currentConfig?.port ?? getPreferredPort();

  await stopBackend({ wait: true });

  const port = await findAvailablePort(preferredPort, host);
  const localUrl = new URL(`http://${LOCALHOST}:${port}`);
  const nextConfig: BackendConfig = {
    host,
    localUrl,
    port,
    remoteEnabled,
  };

  currentConfig = nextConfig;
  backendProcess = startBackend(nextConfig);
  await waitForHttpReady(new URL("/health", localUrl).href, READY_TIMEOUT_MS);
  setTimeout(() => {
    mainWindow?.loadURL(localUrl.href).catch((error) => console.error(error));
  }, 0);
  logExposure(nextConfig);

  return nextConfig;
}

function createWindow(appUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    title: "RepoBinder",
    backgroundColor: "#11140f",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((error) => console.error(error));
    return { action: "deny" };
  });

  window.loadURL(appUrl).catch((error) => {
    console.error(error);
  });

  return window;
}

function startBackend(config: BackendConfig): ChildProcess {
  const serverEntry = resolveServerEntry();
  const webDist = resolveWebDist();
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOST: config.host,
      PORT: String(config.port),
      REPOBINDER_DATA_DIR: app.getPath("userData"),
      REPOBINDER_DESKTOP_TOKEN: desktopToken,
      REPOBINDER_WEB_DIST: webDist,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[backend] ${chunk.toString()}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[backend] ${chunk.toString()}`);
  });

  child.on("exit", (code, signal) => {
    if (isQuitting || signal === "SIGTERM" || intentionalBackendStops.delete(child)) {
      return;
    }

    console.error(`Backend exited unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}`);

    if (backendProcess === child) {
      backendProcess = undefined;
      scheduleBackendRestart();
    }
  });

  child.on("error", (error) => {
    if (isQuitting || intentionalBackendStops.has(child)) {
      return;
    }

    console.error(error);

    if (backendProcess === child) {
      backendProcess = undefined;
      scheduleBackendRestart();
    }
  });

  return child;
}

function stopBackend(options: { wait?: boolean } = {}): Promise<void> {
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = undefined;
  }

  if (!backendProcess) {
    return Promise.resolve();
  }

  const child = backendProcess;
  backendProcess = undefined;
  intentionalBackendStops.add(child);

  if (!options.wait) {
    child.kill("SIGTERM");
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(done, 5_000);

    function done(): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      child.off("exit", done);
      resolve();
    }

    child.once("exit", done);

    if (!child.kill("SIGTERM")) {
      done();
    }
  });
}

function scheduleBackendRestart(): void {
  if (!currentConfig || backendRestartTimer || backendProcess) {
    return;
  }

  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = undefined;

    if (!currentConfig || isQuitting || backendProcess) {
      return;
    }

    const config = currentConfig;
    const child = startBackend(config);
    backendProcess = child;
    waitForHttpReady(new URL("/health", config.localUrl).href, READY_TIMEOUT_MS)
      .then(() => mainWindow?.loadURL(config.localUrl.href))
      .catch((error: unknown) => {
        console.error(error);

        if (backendProcess !== child) {
          scheduleBackendRestart();
          return;
        }

        void stopBackend({ wait: true }).then(() => scheduleBackendRestart());
      });
  }, 1_000);
}

function resolveServerEntry(): string {
  if (process.env.REPOBINDER_SERVER_ENTRY) {
    return path.resolve(process.env.REPOBINDER_SERVER_ENTRY);
  }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, "server", "index.js");
  }

  return path.resolve(__dirname, "..", "server", "index.js");
}

function resolveWebDist(): string {
  if (process.env.REPOBINDER_WEB_DIST) {
    return path.resolve(process.env.REPOBINDER_WEB_DIST);
  }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, "dist-web");
  }

  return path.resolve(__dirname, "..", "..", "dist-web");
}

async function getInitialRemoteMode(): Promise<boolean> {
  if (isRemoteLaunchOverrideEnabled()) {
    return true;
  }

  return readStoredRemoteModeEnabled();
}

function isRemoteLaunchOverrideEnabled(): boolean {
  return process.env.REPOBINDER_REMOTE === "1" || process.argv.includes("--remote");
}

async function readStoredRemoteModeEnabled(): Promise<boolean> {
  try {
    const rawStore = await fs.readFile(resolveDesktopStorePath(), "utf8");
    const store = JSON.parse(rawStore) as unknown;

    if (!isRecord(store) || !isRecord(store.appSettings) || !isRecord(store.appSettings.remoteMode)) {
      return false;
    }

    return store.appSettings.remoteMode.enabled === true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function resolveDesktopStorePath(): string {
  return path.join(app.getPath("userData"), "repobinder-store.json");
}

function getBindHost(remoteEnabled: boolean): string {
  const hostArg = process.argv.find((arg) => arg.startsWith("--host="));

  if (hostArg) {
    return hostArg.slice("--host=".length);
  }

  return remoteEnabled ? REMOTE_HOST : LOCALHOST;
}

function getPreferredPort(): number {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const rawPort = portArg?.slice("--port=".length) || process.env.REPOBINDER_PORT || String(DEFAULT_PORT);
  const parsedPort = Number(rawPort);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  return parsedPort;
}

async function findAvailablePort(preferredPort: number, host: string): Promise<number> {
  for (let candidate = preferredPort; candidate < preferredPort + 50 && candidate <= 65535; candidate += 1) {
    if (await canListen(candidate, host)) {
      return candidate;
    }
  }

  throw new Error(`No available port found starting at ${preferredPort}`);
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, host);
  });
}

function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const request = http.get(url, (response) => {
        response.resume();

        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }

        retryOrReject();
      });

      request.on("error", retryOrReject);
      request.setTimeout(1_000, () => {
        request.destroy();
        retryOrReject();
      });
    };

    const retryOrReject = (): void => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Backend did not become ready at ${url}`));
        return;
      }

      setTimeout(attempt, 150);
    };

    attempt();
  });
}

function logExposure(config: BackendConfig): void {
  console.log(`RepoBinder desktop loaded ${config.localUrl.href}`);

  if (!config.remoteEnabled) {
    console.log("Remote access disabled. Set REPOBINDER_REMOTE=1 or pass --remote to bind 0.0.0.0.");
    return;
  }

  console.log("Remote access enabled. Add auth before using this on an untrusted network.");

  for (const url of getRemoteUrls(config.port)) {
    console.log(`Remote candidate: ${url}`);
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function getRemoteUrls(port: number): string[] {
  const urls: string[] = [];

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }

  return urls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
