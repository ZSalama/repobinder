import { TrackedProcessRole } from "../store";

// Worktree Setup Script metadata is a v1 schema keyed on `status`.
export type SetupMetadataStatus = "success" | "warning" | "failed";

export type SetupProcessMetadata = {
  pid: number;
  role?: TrackedProcessRole;
  primary?: boolean;
  command?: string;
  args?: string[];
  url?: string;
  port?: number;
};

export type SetupDevServerMetadata = {
  url?: string;
  port?: number;
  pid?: number;
};

export type SetupMetadata = {
  status?: SetupMetadataStatus;
  warnings: string[];
  devServer?: SetupDevServerMetadata;
  processes: SetupProcessMetadata[];
};

export type SetupMetadataParse =
  | { kind: "none" }
  | { kind: "parsed"; metadata: SetupMetadata }
  | { kind: "unparsed" };

// When metadata is present, stdout must be pure JSON. Progress logs belong on
// stderr. We therefore only attempt to parse the entire trimmed stdout as JSON.
export function parseSetupMetadata(stdout: string): SetupMetadataParse {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    return { kind: "none" };
  }

  let document: unknown;

  try {
    document = JSON.parse(trimmed);
  } catch {
    return { kind: "unparsed" };
  }

  if (!isRecord(document)) {
    return { kind: "unparsed" };
  }

  return { kind: "parsed", metadata: normalizeMetadata(document) };
}

function normalizeMetadata(document: Record<string, unknown>): SetupMetadata {
  return {
    status: readStatus(document.status),
    warnings: readStringArray(document.warnings),
    devServer: readDevServer(document.devServer),
    processes: readProcesses(document.processes),
  };
}

function readStatus(value: unknown): SetupMetadataStatus | undefined {
  if (value === "success" || value === "warning" || value === "failed") {
    return value;
  }

  return undefined;
}

function readDevServer(value: unknown): SetupDevServerMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const url = readNonEmptyString(value.url);
  const port = readPort(value.port);
  const pid = readPid(value.pid);

  if (url === undefined && port === undefined && pid === undefined) {
    return undefined;
  }

  return { url, port, pid };
}

function readProcesses(value: unknown): SetupProcessMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const processes: SetupProcessMetadata[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }

    const pid = readPid(entry.pid);

    if (pid === undefined) {
      continue;
    }

    processes.push({
      pid,
      role: readRole(entry.role),
      primary: entry.primary === true,
      command: readNonEmptyString(entry.command),
      args: Array.isArray(entry.args) ? readStringArray(entry.args) : undefined,
      url: readNonEmptyString(entry.url),
      port: readPort(entry.port),
    });
  }

  return processes;
}

function readRole(value: unknown): TrackedProcessRole | undefined {
  if (value === "setup" || value === "dev_server" || value === "other") {
    return value;
  }

  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// PIDs must be positive integers greater than 1 to be trackable.
function readPid(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 1) {
    return undefined;
  }

  return value;
}

function readPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return undefined;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
