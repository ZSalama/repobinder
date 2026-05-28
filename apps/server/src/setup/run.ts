import { spawn } from "node:child_process";
import path from "node:path";

import { ApiError } from "../lib/errors";
import { SetupStatus, TrackedProcessRole } from "../store";
import { parseSetupMetadata, SetupMetadata } from "./metadata";
import { isPortListening } from "./status";

export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
export const SETUP_OUTPUT_LIMIT_BYTES = 256 * 1024;
const PORT_RESERVATION_START = 3000;
const PORT_RESERVATION_MAX = 65535;

export type SetupRunInput = {
  command: string;
  args: string[];
  cwd: string;
};

export type TrackedProcessInput = {
  role: TrackedProcessRole;
  pid: number;
  command?: string;
  args: string[];
  url?: string;
  port?: number;
  primary: boolean;
};

export type SetupRunResult = {
  status: SetupStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  metadataParsed: boolean;
  metadata?: SetupMetadata;
  warnings: string[];
  trackedProcesses: TrackedProcessInput[];
  devServer?: { url?: string; port?: number; pid?: number };
  launchError?: string;
};

// Reserve a contiguous count of free loopback ports for a batch, scanning upward
// from 3000 and skipping ports that are already listening or already reserved.
export async function reserveBatchPorts(count: number): Promise<number[]> {
  const reserved: number[] = [];

  for (let candidate = PORT_RESERVATION_START; reserved.length < count; candidate += 1) {
    if (candidate > PORT_RESERVATION_MAX) {
      throw new ApiError(500, "No available ports for Auto Start Dev Server");
    }

    if (reserved.includes(candidate)) {
      continue;
    }

    if (!(await isPortListening(candidate))) {
      reserved.push(candidate);
    }
  }

  return reserved;
}

// RepoBinder spawns setup commands directly (never through a shell). The script
// runs inside the new Linked Worktree and may emit optional v1 metadata JSON on
// stdout. Progress logs belong on stderr.
export function runSetupScript(input: SetupRunInput): Promise<SetupRunResult> {
  const startedAt = Date.now();
  const file = resolveCommand(input.command, input.cwd);

  return new Promise((resolve) => {
    const child = spawn(file, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SETUP_TIMEOUT_MS);

    const enforceLimit = (): void => {
      if (truncated) {
        return;
      }

      truncated = true;
      child.kill("SIGKILL");
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");

      if (stdoutBytes <= SETUP_OUTPUT_LIMIT_BYTES) {
        stdout += chunk;
      } else {
        enforceLimit();
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");

      if (stderrBytes <= SETUP_OUTPUT_LIMIT_BYTES) {
        stderr += chunk;
      } else {
        enforceLimit();
      }
    });

    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null, launchError?: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(buildResult({ stdout, stderr, exitCode, signal, timedOut, truncated, startedAt, launchError }));
    };

    child.on("error", (error) => finalize(null, null, error.message));
    child.on("close", (code, signal) => finalize(code, signal));
  });
}

function buildResult(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  startedAt: number;
  launchError?: string;
}): SetupRunResult {
  const durationMs = Date.now() - input.startedAt;
  const base = {
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    truncated: input.truncated,
    durationMs,
    stdout: input.stdout,
    stderr: input.stderr,
    launchError: input.launchError,
  };

  if (input.launchError) {
    return {
      ...base,
      status: "failed",
      metadataParsed: false,
      warnings: [`Setup script failed to launch: ${input.launchError}`],
      trackedProcesses: [],
    };
  }

  if (input.timedOut) {
    return {
      ...base,
      status: "failed",
      metadataParsed: false,
      warnings: ["Setup script exceeded the 10 minute timeout"],
      trackedProcesses: [],
    };
  }

  if (input.truncated) {
    return {
      ...base,
      status: "failed",
      metadataParsed: false,
      warnings: ["Setup script output exceeded the 256 KiB capture limit"],
      trackedProcesses: [],
    };
  }

  const parse = parseSetupMetadata(input.stdout);
  const metadata = parse.kind === "parsed" ? parse.metadata : undefined;

  // Non-zero exit always counts as failed, even if metadata claims success.
  if (input.exitCode !== 0) {
    return {
      ...base,
      status: "failed",
      metadataParsed: parse.kind === "parsed",
      metadata,
      warnings: collectWarnings(metadata, `Setup script exited with code ${String(input.exitCode)}`),
      trackedProcesses: metadata ? collectTrackedProcesses(metadata) : [],
      devServer: metadata ? resolveDevServer(metadata) : undefined,
    };
  }

  if (!metadata) {
    const warnings = parse.kind === "unparsed" ? ["Setup produced output but no metadata JSON was parsed"] : [];

    return {
      ...base,
      status: "success",
      metadataParsed: false,
      warnings,
      trackedProcesses: [],
    };
  }

  const status = metadata.status ?? "success";

  return {
    ...base,
    status,
    metadataParsed: true,
    metadata,
    warnings: metadata.warnings,
    trackedProcesses: collectTrackedProcesses(metadata),
    devServer: resolveDevServer(metadata),
  };
}

function collectWarnings(metadata: SetupMetadata | undefined, message: string): string[] {
  return metadata ? [message, ...metadata.warnings] : [message];
}

export function collectTrackedProcesses(metadata: SetupMetadata): TrackedProcessInput[] {
  const processes: TrackedProcessInput[] = [];
  let primaryAssigned = false;

  for (const entry of metadata.processes) {
    const primary = entry.primary === true && !primaryAssigned;

    if (primary) {
      primaryAssigned = true;
    }

    processes.push({
      role: entry.role ?? (primary ? "dev_server" : "other"),
      pid: entry.pid,
      command: entry.command,
      args: entry.args ?? [],
      url: entry.url,
      port: entry.port,
      primary,
    });
  }

  // A Dev Server PID reported only on the devServer field still counts as a
  // tracked process so deletion can clean it up later.
  const devServerPid = metadata.devServer?.pid;

  if (devServerPid !== undefined && !processes.some((entry) => entry.pid === devServerPid)) {
    processes.unshift({
      role: "dev_server",
      pid: devServerPid,
      args: [],
      url: metadata.devServer?.url,
      port: metadata.devServer?.port,
      primary: !primaryAssigned,
    });
    primaryAssigned = true;
  }

  // Ensure at most one primary process. If none was flagged, promote the first
  // dev server process.
  if (!processes.some((entry) => entry.primary)) {
    const devServer = processes.find((entry) => entry.role === "dev_server");

    if (devServer) {
      devServer.primary = true;
    }
  }

  return processes;
}

export function resolveDevServer(metadata: SetupMetadata): { url?: string; port?: number; pid?: number } | undefined {
  if (metadata.devServer) {
    return metadata.devServer;
  }

  const primary = metadata.processes.find((entry) => entry.primary) ?? metadata.processes.find((entry) => entry.role === "dev_server");

  if (primary && (primary.url || primary.port)) {
    return { url: primary.url, port: primary.port, pid: primary.pid };
  }

  return undefined;
}

function resolveCommand(command: string, cwd: string): string {
  if (isPathLikeCommand(command)) {
    return path.isAbsolute(command) ? command : path.resolve(cwd, command);
  }

  return command;
}

function isPathLikeCommand(command: string): boolean {
  return path.isAbsolute(command) || command.startsWith(".") || command.includes("/") || command.includes("\\");
}
