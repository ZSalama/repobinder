import { ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions } from "electron";

const DEFAULT_PORT = 3773;
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

app.whenReady().then(startDesktopApp).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
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
  const remoteEnabled = isRemoteEnabled();
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
    if (isQuitting || signal === "SIGTERM") {
      return;
    }

    console.error(`Backend exited unexpectedly: code=${code ?? "null"} signal=${signal ?? "null"}`);
    backendProcess = undefined;
    scheduleBackendRestart();
  });

  child.on("error", (error) => {
    if (isQuitting) {
      return;
    }

    console.error(error);
    backendProcess = undefined;
    scheduleBackendRestart();
  });

  return child;
}

function stopBackend(): void {
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = undefined;
  }

  if (!backendProcess || backendProcess.killed) {
    return;
  }

  backendProcess.kill("SIGTERM");
  backendProcess = undefined;
}

function scheduleBackendRestart(): void {
  if (!currentConfig || backendRestartTimer) {
    return;
  }

  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = undefined;

    if (!currentConfig || isQuitting) {
      return;
    }

    const config = currentConfig;
    backendProcess = startBackend(config);
    waitForHttpReady(new URL("/health", config.localUrl).href, READY_TIMEOUT_MS)
      .then(() => mainWindow?.loadURL(config.localUrl.href))
      .catch((error: unknown) => {
        console.error(error);
        scheduleBackendRestart();
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

function isRemoteEnabled(): boolean {
  return process.env.REPOBINDER_REMOTE === "1" || process.argv.includes("--remote");
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
