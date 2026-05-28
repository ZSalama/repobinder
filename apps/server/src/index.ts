import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import express, { NextFunction, Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 3773;
const DEFAULT_HOST = "127.0.0.1";
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

type Worktree = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
};

type RepositoryInspection = {
  repositoryPath: string;
  worktrees: Worktree[];
  branches: string[];
};

type SocketMessage =
  | {
      type: "server.ready";
      port: number;
      host: string;
      remoteEnabled: boolean;
    }
  | {
      type: "worktrees.changed";
      repositoryPath: string;
      action: "created" | "removed";
    };

class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const port = parsePort(process.env.PORT);
const host = process.env.HOST || DEFAULT_HOST;
const webDist = path.resolve(process.env.REPOBINDER_WEB_DIST || path.join(process.cwd(), "dist-web"));
const app = express();
const server = http.createServer(app);
const sockets = new WebSocketServer({ noServer: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.type("text/plain").send("ok");
});

app.get("/api/server", (_request, response) => {
  response.json({
    name: "repobinder",
    host,
    port,
    remoteEnabled: host === "0.0.0.0",
    advertisedUrls: getAdvertisedUrls(host, port),
  });
});

app.post("/api/repositories/inspect", async (request, response, next) => {
  try {
    const repositoryPath = readRequiredString(request.body, "repositoryPath");
    response.json(await inspectRepository(repositoryPath));
  } catch (error) {
    next(error);
  }
});

app.post("/api/worktrees", async (request, response, next) => {
  try {
    const repositoryPath = readRequiredString(request.body, "repositoryPath");
    const worktreePath = readRequiredString(request.body, "worktreePath");
    const branchName = readOptionalString(request.body, "branchName");
    const baseRef = readOptionalString(request.body, "baseRef");
    const createBranch = Boolean(request.body?.createBranch);
    const inspection = await inspectRepository(repositoryPath);
    const args = buildAddWorktreeArgs(worktreePath, branchName, baseRef, createBranch);

    await runGit(inspection.repositoryPath, args);
    const nextInspection = await inspectRepository(inspection.repositoryPath);
    broadcast({
      type: "worktrees.changed",
      repositoryPath: inspection.repositoryPath,
      action: "created",
    });

    response.status(201).json(nextInspection);
  } catch (error) {
    next(error);
  }
});

app.post("/api/worktrees/remove", async (request, response, next) => {
  try {
    const repositoryPath = readRequiredString(request.body, "repositoryPath");
    const worktreePath = readRequiredString(request.body, "worktreePath");
    const force = Boolean(request.body?.force);
    const inspection = await inspectRepository(repositoryPath);
    const args = ["worktree", "remove"];

    if (force) {
      args.push("--force");
    }

    args.push(worktreePath);
    await runGit(inspection.repositoryPath, args);

    const nextInspection = await inspectRepository(inspection.repositoryPath);
    broadcast({
      type: "worktrees.changed",
      repositoryPath: inspection.repositoryPath,
      action: "removed",
    });

    response.json(nextInspection);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(webDist));

app.get(/.*/, (request, response, next) => {
  if (request.path.startsWith("/api/")) {
    next();
    return;
  }

  response.sendFile(path.join(webDist, "index.html"), (error) => {
    if (error) {
      next(error);
    }
  });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const apiError = toApiError(error);
  response.status(apiError.statusCode).json({ error: apiError.message });
});

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  sockets.handleUpgrade(request, socket, head, (websocket) => {
    sockets.emit("connection", websocket, request);
  });
});

sockets.on("connection", (websocket) => {
  sendJson(websocket, {
    type: "server.ready",
    host,
    port,
    remoteEnabled: host === "0.0.0.0",
  });
});

server.listen(port, host, () => {
  const urls = getAdvertisedUrls(host, port).join(", ");
  console.log(`RepoBinder backend listening on ${host}:${port}`);
  console.log(`Open ${urls}`);
});

process.on("SIGTERM", () => {
  shutdown();
});

process.on("SIGINT", () => {
  shutdown();
});

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsedPort = Number(rawPort);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }

  return parsedPort;
}

function readRequiredString(body: unknown, field: string): string {
  const value = readOptionalString(body, field);

  if (!value) {
    throw new ApiError(400, `Missing ${field}`);
  }

  return value;
}

function readOptionalString(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const value = body[field];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildAddWorktreeArgs(
  worktreePath: string,
  branchName: string | undefined,
  baseRef: string | undefined,
  createBranch: boolean,
): string[] {
  const args = ["worktree", "add"];

  if (createBranch) {
    if (!branchName) {
      throw new ApiError(400, "Branch name is required when creating a branch");
    }

    args.push("-b", branchName, worktreePath);

    if (baseRef) {
      args.push(baseRef);
    }

    return args;
  }

  args.push(worktreePath);

  if (branchName) {
    args.push(branchName);
  }

  return args;
}

async function inspectRepository(inputPath: string): Promise<RepositoryInspection> {
  const repositoryPath = path.resolve(inputPath);

  try {
    await fs.access(repositoryPath);
  } catch {
    throw new ApiError(404, `Path does not exist: ${repositoryPath}`);
  }

  const root = (await runGit(repositoryPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const worktreeOutput = (await runGit(root, ["worktree", "list", "--porcelain"])).stdout;
  const branchOutput = (await runGit(root, ["branch", "--format=%(refname:short)"])).stdout;

  return {
    repositoryPath: root,
    worktrees: parseWorktreePorcelain(worktreeOutput),
    branches: branchOutput
      .split("\n")
      .map((branch) => branch.trim())
      .filter(Boolean),
  };
}

async function runGit(repositoryPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", ["-C", repositoryPath, ...args], {
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    if (isExecError(error)) {
      const details = error.stderr?.trim() || error.stdout?.trim() || error.message;
      throw new ApiError(400, details);
    }

    throw error;
  }
}

function parseWorktreePorcelain(output: string): Worktree[] {
  return output
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((entry) => {
      const worktree: Worktree = {
        path: "",
        detached: false,
        bare: false,
      };

      for (const line of entry.split("\n")) {
        const separator = line.indexOf(" ");
        const key = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1);

        switch (key) {
          case "worktree":
            worktree.path = value;
            break;
          case "HEAD":
            worktree.head = value;
            break;
          case "branch":
            worktree.branch = value.replace(/^refs\/heads\//, "");
            break;
          case "bare":
            worktree.bare = true;
            break;
          case "detached":
            worktree.detached = true;
            break;
          case "locked":
            worktree.locked = value || "locked";
            break;
          case "prunable":
            worktree.prunable = value || "prunable";
            break;
        }
      }

      return worktree;
    });
}

function getAdvertisedUrls(bindHost: string, bindPort: number): string[] {
  const urls = new Set<string>([`http://127.0.0.1:${bindPort}`]);

  if (bindHost !== "0.0.0.0") {
    return [...urls];
  }

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.add(`http://${address.address}:${bindPort}`);
      }
    }
  }

  return [...urls];
}

function broadcast(message: SocketMessage): void {
  for (const socket of sockets.clients) {
    sendJson(socket, message);
  }
}

function sendJson(socket: WebSocket, message: SocketMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function shutdown(): void {
  sockets.close();
  server.close(() => {
    process.exit(0);
  });
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    return new ApiError(500, error.message);
  }

  return new ApiError(500, "Unknown server error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExecError(value: unknown): value is Error & { stdout?: string; stderr?: string } {
  return value instanceof Error;
}
