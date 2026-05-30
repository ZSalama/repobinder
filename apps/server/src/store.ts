import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STORE_SCHEMA_VERSION = 1;
export const OPERATION_RETENTION_LIMIT = 100;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type WorktreeType = "primary" | "linked";
export type WorktreeAvailability = "available" | "missing" | "unknown";
export type SetupStatus = "not_configured" | "pending" | "running" | "success" | "warning" | "failed" | "skipped";
export type DevServerStatus = "unknown" | "running" | "stopped" | "unreachable";
export type TrackedProcessRole = "setup" | "dev_server" | "other";
export type TrackedProcessStatus = "unknown" | "running" | "stopped" | "failed";
export type OperationSeverity = "info" | "success" | "warning" | "error";
export type OperationStatus = "pending" | "success" | "warning" | "failed";

export type RepositoryRecord = {
  repositoryId: string;
  displayName: string;
  primaryWorktreeId: string;
  primaryWorktreePath: string;
  realPrimaryWorktreePath: string;
  gitCommonDir: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type RepositorySettingsRecord = {
  repositoryId: string;
  setup: {
    enabled: boolean;
    command?: string;
    defaultArgs: string[];
    autoStartDevServer: boolean;
    tailscaleRouting: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type AppSettingsRecord = {
  remoteMode: {
    enabled: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type WorktreeRecord = {
  worktreeId: string;
  repositoryId: string;
  type: WorktreeType;
  worktreePath: string;
  realWorktreePath: string;
  gitCommonDir: string;
  branch?: string;
  head?: string;
  availability: WorktreeAvailability;
  locked?: string;
  prunable?: string;
  createdByRepoBinder: boolean;
  setup: {
    status: SetupStatus;
    updatedAt?: string;
    warnings: string[];
    lastExitCode?: number;
  };
  devServer?: {
    status: DevServerStatus;
    url?: string;
    port?: number;
    pid?: number;
    updatedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type TrackedProcessRecord = {
  processRecordId: string;
  repositoryId: string;
  worktreeId: string;
  role: TrackedProcessRole;
  status: TrackedProcessStatus;
  pid: number;
  command?: string;
  args: string[];
  cwd: string;
  url?: string;
  port?: number;
  startedAt?: string;
  lastSeenAt?: string;
  stoppedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type OperationRecord = {
  operationId: string;
  type: string;
  status: OperationStatus;
  severity: OperationSeverity;
  summary: string;
  repositoryId?: string;
  worktreeId?: string;
  details?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type SelectionRecord = {
  repositoryId?: string;
  worktreeId?: string;
  updatedAt?: string;
};

export type RepoBinderStore = {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  selection: SelectionRecord;
  appSettings: AppSettingsRecord;
  repositories: RepositoryRecord[];
  repositorySettings: RepositorySettingsRecord[];
  worktrees: WorktreeRecord[];
  trackedProcesses: TrackedProcessRecord[];
  operations: OperationRecord[];
};

export type CreateOperationInput = {
  type: string;
  status: OperationStatus;
  severity: OperationSeverity;
  summary: string;
  repositoryId?: string;
  worktreeId?: string;
  details?: JsonObject;
};

export class LocalJsonStore {
  private store: RepoBinderStore | undefined;
  private loadPromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  get path(): string {
    return this.storePath;
  }

  async read(): Promise<RepoBinderStore> {
    const store = await this.ensureLoaded();
    return structuredClone(store);
  }

  async update<T>(mutator: (store: RepoBinderStore) => T): Promise<T> {
    const run = this.writeQueue.catch(() => undefined).then(async () => {
      const store = await this.ensureLoaded();
      const result = mutator(store);

      store.updatedAt = nowIso();
      trimOperationRecords(store);
      await writeStoreAtomic(this.storePath, store);

      return result;
    });

    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  async recordOperation(input: CreateOperationInput): Promise<OperationRecord> {
    return this.update((store) => appendOperationRecord(store, input));
  }

  private async ensureLoaded(): Promise<RepoBinderStore> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }

    await this.loadPromise;

    if (!this.store) {
      throw new Error("RepoBinder store did not load");
    }

    return this.store;
  }

  private async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });

    try {
      const rawStore = await fs.readFile(this.storePath, "utf8");
      this.store = migrateStoreDocument(JSON.parse(rawStore) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.store = createEmptyStore(nowIso());
        await writeStoreAtomic(this.storePath, this.store);
        return;
      }

      throw error;
    }
  }
}

export function resolveStorePath(): string {
  return path.join(resolveDataDir(), "repobinder-store.json");
}

export function createRecordId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function createDefaultRepositorySettings(repositoryId: string, timestamp = nowIso()): RepositorySettingsRecord {
  return {
    repositoryId,
    setup: {
      enabled: false,
      defaultArgs: [],
      autoStartDevServer: false,
      tailscaleRouting: false,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createDefaultAppSettings(timestamp = nowIso()): AppSettingsRecord {
  return {
    remoteMode: {
      enabled: false,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function appendOperationRecord(store: RepoBinderStore, input: CreateOperationInput): OperationRecord {
  const timestamp = nowIso();
  const operation: OperationRecord = {
    operationId: createRecordId("operation"),
    type: input.type,
    status: input.status,
    severity: input.severity,
    summary: input.summary,
    repositoryId: input.repositoryId,
    worktreeId: input.worktreeId,
    details: input.details ? structuredClone(input.details) : undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: input.status === "pending" ? undefined : timestamp,
  };

  store.operations.push(operation);
  trimOperationRecords(store);
  return structuredClone(operation);
}

function createEmptyStore(timestamp: string): RepoBinderStore {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    selection: {},
    appSettings: createDefaultAppSettings(timestamp),
    repositories: [],
    repositorySettings: [],
    worktrees: [],
    trackedProcesses: [],
    operations: [],
  };
}

function migrateStoreDocument(document: unknown): RepoBinderStore {
  if (!isRecord(document)) {
    throw new Error("Invalid RepoBinder store: root value must be an object");
  }

  if (document.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error(`Unsupported RepoBinder store schema version: ${String(document.schemaVersion)}`);
  }

  return normalizeStoreV1(document);
}

function normalizeStoreV1(document: Record<string, unknown>): RepoBinderStore {
  const timestamp = nowIso();

  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    createdAt: readString(document.createdAt) ?? timestamp,
    updatedAt: readString(document.updatedAt) ?? timestamp,
    selection: readSelection(document.selection),
    appSettings: readAppSettings(document.appSettings, timestamp),
    repositories: readArray<RepositoryRecord>(document.repositories),
    repositorySettings: normalizeRepositorySettings(readArray<RepositorySettingsRecord>(document.repositorySettings)),
    worktrees: readArray<WorktreeRecord>(document.worktrees),
    trackedProcesses: readArray<TrackedProcessRecord>(document.trackedProcesses),
    operations: readArray<OperationRecord>(document.operations).slice(-OPERATION_RETENTION_LIMIT),
  };
}

function readAppSettings(value: unknown, timestamp: string): AppSettingsRecord {
  if (!isRecord(value)) {
    return createDefaultAppSettings(timestamp);
  }

  const remoteMode = isRecord(value.remoteMode) ? value.remoteMode : {};

  return {
    remoteMode: {
      enabled: Boolean(remoteMode.enabled),
    },
    createdAt: readString(value.createdAt) ?? timestamp,
    updatedAt: readString(value.updatedAt) ?? timestamp,
  };
}

function readSelection(value: unknown): SelectionRecord {
  if (!isRecord(value)) {
    return {};
  }

  return {
    repositoryId: readString(value.repositoryId),
    worktreeId: readString(value.worktreeId),
    updatedAt: readString(value.updatedAt),
  };
}

function readArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (structuredClone(value) as T[]) : [];
}

function normalizeRepositorySettings(records: RepositorySettingsRecord[]): RepositorySettingsRecord[] {
  return records.map((record) => ({
    ...record,
    setup: {
      ...record.setup,
      defaultArgs: Array.isArray(record.setup.defaultArgs) ? record.setup.defaultArgs : [],
      autoStartDevServer: Boolean(record.setup.enabled) && Boolean(record.setup.autoStartDevServer),
      tailscaleRouting:
        Boolean(record.setup.enabled) && Boolean(record.setup.autoStartDevServer) && Boolean(record.setup.tailscaleRouting),
    },
  }));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveDataDir(): string {
  if (process.env.REPOBINDER_DATA_DIR) {
    return path.resolve(process.env.REPOBINDER_DATA_DIR);
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "RepoBinder");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "RepoBinder");
  }

  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "repobinder");
}

function trimOperationRecords(store: RepoBinderStore): void {
  if (store.operations.length <= OPERATION_RETENTION_LIMIT) {
    return;
  }

  store.operations = store.operations.slice(-OPERATION_RETENTION_LIMIT);
}

async function writeStoreAtomic(storePath: string, store: RepoBinderStore): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });

  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  const serializedStore = `${JSON.stringify(store, null, 2)}\n`;

  try {
    await fs.writeFile(tempPath, serializedStore, "utf8");
    await fs.rename(tempPath, storePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
