import net from "node:net";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

// PID liveness is advisory. `process.kill(pid, 0)` throws ESRCH when the process
// is gone and EPERM when it exists but is owned by another user. EPERM still
// proves the PID is alive.
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

// A successful TCP connection to host/port is enough to treat a Dev Server as
// reachable from the RepoBinder host.
export function isPortReachable(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, normalizeConnectHost(host));
  });
}

// A port is considered already in use for reservation purposes when something is
// listening on the loopback interface.
export function isPortListening(port: number, timeoutMs = 300): Promise<boolean> {
  return isPortReachable("127.0.0.1", port, timeoutMs);
}

export function isLocalhostUrl(url: string): boolean {
  const host = parseUrlHost(url);
  return host !== undefined && LOOPBACK_HOSTS.has(host);
}

export function parseUrlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function parseUrlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);

    if (parsed.port) {
      return Number(parsed.port);
    }

    if (parsed.protocol === "https:") {
      return 443;
    }

    if (parsed.protocol === "http:") {
      return 80;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeConnectHost(host: string): string {
  if (host === "[::1]") {
    return "::1";
  }

  // Treat the wildcard bind address as loopback for local reachability checks.
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }

  return host;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
