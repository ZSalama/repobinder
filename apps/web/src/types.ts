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
export type SocketState = "connecting" | "open" | "closed";

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
  trackedProcesses: unknown[];
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
};

export type BatchRowResult = {
  index: number;
  branchName: string;
  worktreePath: string;
  status: "created" | "failed";
  error?: string;
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
    };
  }
}
