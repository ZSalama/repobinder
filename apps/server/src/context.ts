import { ApiError } from "./lib/errors";
import { nowIso } from "./lib/json";
import { broadcast } from "./sockets";
import { CreateOperationInput, LocalJsonStore, RepoBinderStore, resolveStorePath, SelectionRecord } from "./store";

export const localStore = new LocalJsonStore(resolveStorePath());

let mutatingOperation: Promise<unknown> | undefined;

export async function runExclusiveMutation<T>(_operationType: string, operation: () => Promise<T>): Promise<T> {
  if (mutatingOperation) {
    throw new ApiError(409, "Another mutating operation is already running");
  }

  const run = operation();
  mutatingOperation = run;

  try {
    return await run;
  } finally {
    if (mutatingOperation === run) {
      mutatingOperation = undefined;
    }
  }
}

export async function recordOperationSafely(input: CreateOperationInput): Promise<void> {
  try {
    await localStore.recordOperation(input);
    broadcast({ type: "operations.changed" });
  } catch (error) {
    console.error("Failed to record Operation Record", error);
  }
}

export function findVisibleRepository(store: RepoBinderStore, repositoryId: string) {
  const repository = store.repositories.find((record) => record.repositoryId === repositoryId && !record.deletedAt);

  if (!repository) {
    throw new ApiError(404, `Repository Record not found: ${repositoryId}`);
  }

  return repository;
}

export function resolveRequestedSelection(
  store: RepoBinderStore,
  repositoryId: string | undefined,
  worktreeId: string | undefined,
): SelectionRecord {
  const timestamp = nowIso();

  if (!repositoryId) {
    return { updatedAt: timestamp };
  }

  const repository = findVisibleRepository(store, repositoryId);
  const worktree =
    worktreeId !== undefined
      ? store.worktrees.find(
          (record) => record.worktreeId === worktreeId && record.repositoryId === repositoryId && !record.deletedAt,
        )
      : store.worktrees.find((record) => record.worktreeId === repository.primaryWorktreeId && !record.deletedAt);

  if (!worktree) {
    throw new ApiError(404, `Worktree Record not found: ${worktreeId ?? repository.primaryWorktreeId}`);
  }

  return {
    repositoryId,
    worktreeId: worktree.worktreeId,
    updatedAt: timestamp,
  };
}
