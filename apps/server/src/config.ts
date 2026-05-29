import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 3774;
export const DEFAULT_HOST = "127.0.0.1";
export const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

export function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsedPort = Number(rawPort);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }

  return parsedPort;
}

export function getAdvertisedUrls(bindHost: string, bindPort: number): string[] {
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

export const port = parsePort(process.env.PORT);
export const host = process.env.HOST || DEFAULT_HOST;
export const webDist = path.resolve(process.env.REPOBINDER_WEB_DIST || path.join(process.cwd(), "dist-web"));
