export type Worktree = {
  path: string;
  realPath?: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
};

export type RepositoryInspection = {
  repositoryPath: string;
  realRepositoryPath: string;
  gitDir: string;
  realGitDir: string;
  gitCommonDir: string;
  realGitCommonDir: string;
  worktrees: Worktree[];
  branches: string[];
};

export type BatchRow = {
  index: number;
  branchName: string;
  worktreePath: string;
};

export type BatchRowValidation = BatchRow & {
  errors: string[];
};

export type BatchRowOutcome = BatchRow & {
  status: "created" | "failed";
  error?: string;
};

export type SocketMessage =
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
    }
  | {
      type: "operations.changed";
    }
  | {
      type: "state.changed";
      reason: string;
    };
