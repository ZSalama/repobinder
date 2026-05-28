export type WorktreeType = "primary" | "linked";
export type SetupStatus =
  | "not_configured"
  | "pending"
  | "running"
  | "success"
  | "warning"
  | "failed"
  | "skipped";
export type DevServerStatus = "unknown" | "running" | "stopped" | "unreachable";
export type TrackedProcessRole = "setup" | "dev_server" | "other";
export type TrackedProcessStatus = "unknown" | "running" | "stopped" | "failed";
export type SocketState = "connecting" | "open" | "closed";

export type TrackedProcess = {
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

export type RepositorySettings = {
  repositoryId: string;
  setup: {
    enabled: boolean;
    command?: string;
    defaultArgs: string[];
    autoStartDevServer: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type WorktreeResource = {
  worktreeId: string;
  repositoryId: string;
  type: WorktreeType;
  worktreePath: string;
  realWorktreePath: string;
  gitCommonDir: string;
  branch?: string;
  head?: string;
  availability: "available" | "missing" | "unknown";
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
  trackedProcesses: TrackedProcess[];
  createdAt: string;
  updatedAt: string;
};

export type RepositoryResource = {
  repositoryId: string;
  displayName: string;
  primaryWorktreeId: string;
  primaryWorktreePath: string;
  realPrimaryWorktreePath: string;
  gitCommonDir: string;
  settings: RepositorySettings;
  primaryWorktree?: WorktreeResource;
  worktrees: WorktreeResource[];
  createdAt: string;
  updatedAt: string;
};

export type AppStateResource = {
  schemaVersion: number;
  selection: {
    repositoryId?: string;
    worktreeId?: string;
    updatedAt?: string;
  };
  repositories: RepositoryResource[];
  operations: unknown[];
};

export type NewWorktreeContext = {
  repositoryId: string;
  primaryWorktreePath: string;
  baseBranch?: string;
  detached: boolean;
  dirty: boolean;
  setupEnabled: boolean;
  autoStartDevServer: boolean;
};

export type SetupRowResult = {
  status: SetupStatus;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  metadataParsed: boolean;
  warnings: string[];
  stdout: string;
  stderr: string;
  devServer?: { url?: string; port?: number; pid?: number };
};

export type BatchRowResult = {
  index: number;
  branchName: string;
  worktreePath: string;
  status: "created" | "failed";
  error?: string;
  reservedPort?: number;
  devServerStatus?: DevServerStatus;
  setup?: SetupRowResult;
};

export type OpenDevResponse = {
  url: string;
  reachable: boolean;
};

export type BatchResult = {
  baseBranch: string;
  dirty: boolean;
  created: number;
  failed: number;
  warnings: string[];
  rows: BatchRowResult[];
};

export type BatchResponse = {
  state: AppStateResource;
  result: BatchResult;
};

export type DeleteWorktreeResponse = {
  state: AppStateResource;
  result: {
    status: "success" | "warning";
    summary: string;
    deleteBranch: boolean;
    worktreeRemove: { status: "removed" | "already_missing" };
    prune: { status: "not_needed" | "pruned" | "failed"; error?: string };
    branchDelete:
      | { status: "not_requested" }
      | { status: "skipped"; reason: string }
      | { status: "deleted"; branch: string }
      | { status: "failed"; branch: string; error: string };
    softDelete: { status: "applied" } | { status: "not_applied"; reason: string };
    processStops: Array<{
      processRecordId: string;
      role: string;
      pid: number;
      status: "not_running" | "stopped" | "failed";
      forceUsed: boolean;
      descendants: number[];
      error?: string;
    }>;
  };
};

export type BatchValidationRow = {
  index: number;
  branchName: string;
  worktreePath: string;
  errors: string[];
};

export type ServerInfo = {
  name: string;
  host: string;
  port: number;
  remoteEnabled: boolean;
  advertisedUrls: string[];
};

export type DesktopContext = {
  platform: string;
  desktopAuthToken: string;
};

export type SettingsDraft = {
  setupEnabled: boolean;
  command: string;
  defaultArgsText: string;
  autoStartDevServer: boolean;
};

export type Banner = {
  tone: "success" | "warning" | "danger" | "info";
  text: string;
};

declare global {
  interface Window {
    repobinderDesktop?: {
      getDesktopContext: () => Promise<DesktopContext>;
      pickRepositoryFolder: () => Promise<string | undefined>;
      openExternal: (url: string) => Promise<boolean>;
    };
  }
}
