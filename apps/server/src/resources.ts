import {
  createDefaultRepositorySettings,
  OperationRecord,
  RepositoryRecord,
  RepositorySettingsRecord,
  RepoBinderStore,
  STORE_SCHEMA_VERSION,
  SelectionRecord,
  TrackedProcessRecord,
  WorktreeRecord,
} from "./store";

export type WorktreeResource = WorktreeRecord & {
  trackedProcesses: TrackedProcessRecord[];
};

export type RepositoryResource = RepositoryRecord & {
  settings: RepositorySettingsRecord;
  primaryWorktree?: WorktreeResource;
  worktrees: WorktreeResource[];
};

export type StoreMetaResource = {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  storePath: string;
  operationRetentionLimit: number;
};

export type AppStateResource = {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  selection: SelectionRecord;
  repositories: RepositoryResource[];
  operations: OperationRecord[];
};

export type ResourceOptions = {
  includeDeleted?: boolean;
};

export function buildAppStateResource(store: RepoBinderStore, options: ResourceOptions = {}): AppStateResource {
  const repositories = buildRepositoryResources(store, options);

  return {
    schemaVersion: store.schemaVersion,
    selection: resolveVisibleSelection(store.selection, repositories),
    repositories,
    operations: [...store.operations].reverse(),
  };
}

export function buildRepositoryResources(store: RepoBinderStore, options: ResourceOptions = {}): RepositoryResource[] {
  const visibleRepositories = filterDeleted(store.repositories, options);

  return visibleRepositories.map((repository) => buildRepositoryResource(store, repository, options));
}

export function buildRepositoryResource(
  store: RepoBinderStore,
  repository: RepositoryRecord,
  options: ResourceOptions = {},
): RepositoryResource {
  const worktrees = filterDeleted(
    store.worktrees.filter((worktree) => worktree.repositoryId === repository.repositoryId),
    options,
  ).map((worktree) => buildWorktreeResource(store, worktree));
  const settings =
    store.repositorySettings.find((record) => record.repositoryId === repository.repositoryId) ??
    createDefaultRepositorySettings(repository.repositoryId, repository.createdAt);

  return {
    ...repository,
    settings,
    primaryWorktree:
      worktrees.find((worktree) => worktree.worktreeId === repository.primaryWorktreeId) ??
      worktrees.find((worktree) => worktree.type === "primary"),
    worktrees,
  };
}

export function buildWorktreeResources(store: RepoBinderStore, options: ResourceOptions = {}): WorktreeResource[] {
  return filterDeleted(store.worktrees, options).map((worktree) => buildWorktreeResource(store, worktree));
}

export function buildWorktreeResource(store: RepoBinderStore, worktree: WorktreeRecord): WorktreeResource {
  return {
    ...worktree,
    trackedProcesses: store.trackedProcesses.filter((process) => process.worktreeId === worktree.worktreeId),
  };
}

function filterDeleted<T extends { deletedAt?: string }>(records: T[], options: ResourceOptions): T[] {
  if (options.includeDeleted) {
    return [...records];
  }

  return records.filter((record) => !record.deletedAt);
}

function resolveVisibleSelection(selection: SelectionRecord, repositories: RepositoryResource[]): SelectionRecord {
  const selectedRepository =
    repositories.find((repository) => repository.repositoryId === selection.repositoryId) ?? repositories[0];

  if (!selectedRepository) {
    return {};
  }

  const selectedWorktree =
    selectedRepository.worktrees.find((worktree) => worktree.worktreeId === selection.worktreeId) ??
    selectedRepository.primaryWorktree ??
    selectedRepository.worktrees[0];

  return {
    repositoryId: selectedRepository.repositoryId,
    worktreeId: selectedWorktree?.worktreeId,
    updatedAt: selection.updatedAt,
  };
}
