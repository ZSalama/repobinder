import { DevServerStatus, TrackedProcessStatus } from "../store";
import { isPortReachable, isProcessAlive, parseUrlHost, parseUrlPort } from "./status";

export type DevServerMetadata = { url?: string; port?: number; pid?: number };

// Resolve a Dev Server's live status. Port reachability is the primary signal
// because PID identity cannot be verified reliably. A known PID is advisory.
export async function probeDevServerStatus(devServer: DevServerMetadata): Promise<DevServerStatus> {
  const host = devServer.url ? parseUrlHost(devServer.url) ?? "127.0.0.1" : "127.0.0.1";
  const port = devServer.port ?? (devServer.url ? parseUrlPort(devServer.url) : undefined);

  if (port !== undefined) {
    return (await isPortReachable(host, port)) ? "running" : "unreachable";
  }

  if (devServer.pid !== undefined) {
    return isProcessAlive(devServer.pid) ? "running" : "stopped";
  }

  return "unknown";
}

export function probeProcessStatus(pid: number): TrackedProcessStatus {
  return isProcessAlive(pid) ? "running" : "stopped";
}
