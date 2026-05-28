import { execFileAsync } from "../git/exec";
import { isProcessAlive } from "./status";

export type StopProcessTreeStatus = "not_running" | "stopped" | "failed";

export type StopProcessTreeResult = {
  pid: number;
  status: StopProcessTreeStatus;
  forceUsed: boolean;
  descendants: number[];
  error?: string;
};

const GRACEFUL_STOP_WAIT_MS = 1_500;
const FORCE_STOP_WAIT_MS = 750;

export async function stopProcessTree(pid: number): Promise<StopProcessTreeResult> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return {
      pid,
      status: "failed",
      forceUsed: false,
      descendants: [],
      error: "Tracked PID is invalid",
    };
  }

  if (!isProcessAlive(pid)) {
    return {
      pid,
      status: "not_running",
      forceUsed: false,
      descendants: [],
    };
  }

  if (process.platform === "win32") {
    return stopWindowsProcessTree(pid);
  }

  return stopPosixProcessTree(pid);
}

async function stopWindowsProcessTree(pid: number): Promise<StopProcessTreeResult> {
  const gracefulError = await taskkill(pid, false);

  await delay(GRACEFUL_STOP_WAIT_MS);

  if (!isProcessAlive(pid)) {
    return {
      pid,
      status: "stopped",
      forceUsed: false,
      descendants: [],
      error: gracefulError,
    };
  }

  const forceError = await taskkill(pid, true);

  await delay(FORCE_STOP_WAIT_MS);

  return {
    pid,
    status: isProcessAlive(pid) ? "failed" : "stopped",
    forceUsed: true,
    descendants: [],
    error: forceError ?? gracefulError,
  };
}

async function stopPosixProcessTree(pid: number): Promise<StopProcessTreeResult> {
  const tree = await collectPosixProcessTree(pid);
  const targets = [...tree.descendants].reverse().concat(pid);
  const gracefulErrors = signalProcesses(targets, "SIGTERM");

  await delay(GRACEFUL_STOP_WAIT_MS);

  const afterGraceTree = await collectPosixProcessTree(pid);
  const afterGraceTargets = [...afterGraceTree.descendants].reverse().concat(pid).filter(isProcessAlive);

  if (afterGraceTargets.length === 0) {
    return {
      pid,
      status: "stopped",
      forceUsed: false,
      descendants: tree.descendants,
      error: gracefulErrors[0],
    };
  }

  const forceErrors = signalProcesses(afterGraceTargets, "SIGKILL");

  await delay(FORCE_STOP_WAIT_MS);

  const afterForceTree = await collectPosixProcessTree(pid);
  const afterForceTargets = [...afterForceTree.descendants, pid].filter(isProcessAlive);

  return {
    pid,
    status: afterForceTargets.length > 0 ? "failed" : "stopped",
    forceUsed: true,
    descendants: Array.from(new Set([...tree.descendants, ...afterGraceTree.descendants, ...afterForceTree.descendants])),
    error: forceErrors[0] ?? gracefulErrors[0],
  };
}

async function collectPosixProcessTree(pid: number): Promise<{ descendants: number[] }> {
  const seen = new Set<number>();

  async function visit(parentPid: number): Promise<number[]> {
    const children = await listChildPids(parentPid);
    const descendants: number[] = [];

    for (const child of children) {
      if (seen.has(child)) {
        continue;
      }

      seen.add(child);
      descendants.push(child, ...(await visit(child)));
    }

    return descendants;
  }

  return { descendants: await visit(pid) };
}

async function listChildPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)], { windowsHide: true });

    return stdout
      .split(/\s+/)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry > 1);
  } catch {
    return [];
  }
}

function signalProcesses(pids: number[], signal: NodeJS.Signals): string[] {
  const errors: string[] = [];

  for (const pid of pids) {
    if (!isProcessAlive(pid)) {
      continue;
    }

    try {
      process.kill(pid, signal);
    } catch (error) {
      if (isNodeError(error) && error.code === "ESRCH") {
        continue;
      }

      errors.push(error instanceof Error ? error.message : `Failed to send ${signal} to PID ${pid}`);
    }
  }

  return errors;
}

async function taskkill(pid: number, force: boolean): Promise<string | undefined> {
  const args = ["/PID", String(pid), "/T"];

  if (force) {
    args.push("/F");
  }

  try {
    await execFileAsync("taskkill", args, { windowsHide: true });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : `Failed to stop PID ${pid}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
