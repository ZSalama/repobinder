import fs from "node:fs/promises";
import path from "node:path";

import { ApiError } from "../lib/errors";
import { BatchRow, BatchRowValidation, RepositoryInspection } from "../lib/types";
import { RepoBinderStore, WorktreeRecord } from "../store";
import { execFileAsync, runGit } from "./exec";

export function buildAddWorktreeArgs(
  worktreePath: string,
  branchName: string | undefined,
  baseRef: string | undefined,
  createBranch: boolean,
): string[] {
  const args = ["worktree", "add"];

  if (createBranch) {
    if (!branchName) {
      throw new ApiError(400, "Branch name is required when creating a branch");
    }

    args.push("-b", branchName, worktreePath);

    if (baseRef) {
      args.push(baseRef);
    }

    return args;
  }

  args.push(worktreePath);

  if (branchName) {
    args.push(branchName);
  }

  return args;
}

export function createWorktreeRecord(input: {
  worktreeId: string;
  repositoryId: string;
  type: WorktreeRecord["type"];
  worktreePath: string;
  realWorktreePath: string;
  gitCommonDir: string;
  branch?: string;
  head?: string;
  locked?: string;
  prunable?: string;
  createdByRepoBinder: boolean;
  setupStatus: WorktreeRecord["setup"]["status"];
  setupWarnings?: string[];
  setupLastExitCode?: number;
  devServer?: WorktreeRecord["devServer"];
  timestamp: string;
}): WorktreeRecord {
  return {
    worktreeId: input.worktreeId,
    repositoryId: input.repositoryId,
    type: input.type,
    worktreePath: input.worktreePath,
    realWorktreePath: input.realWorktreePath,
    gitCommonDir: input.gitCommonDir,
    branch: input.branch,
    head: input.head,
    availability: "available",
    locked: input.locked,
    prunable: input.prunable,
    createdByRepoBinder: input.createdByRepoBinder,
    setup: {
      status: input.setupStatus,
      updatedAt: input.timestamp,
      warnings: input.setupWarnings ?? [],
      lastExitCode: input.setupLastExitCode,
    },
    devServer: input.devServer,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

export function resolveBatchRows(names: (string | undefined)[], primaryWorktreePath: string): BatchRow[] {
  const firstBranch = names[0] as string;
  const resolvedPrimaryPath = path.resolve(primaryWorktreePath);
  const parentDir = path.dirname(resolvedPrimaryPath);
  const baseFolderName = path.basename(resolvedPrimaryPath);

  return names.map((name, index) => {
    const branchName = name ?? `${firstBranch}-${index + 1}`;
    const slug = slugifyBranchName(branchName);

    return {
      index,
      branchName,
      worktreePath: path.join(parentDir, `${baseFolderName}-${slug}`),
    };
  });
}

export async function validateBatchRows(
  rows: BatchRow[],
  inspection: RepositoryInspection,
  store: RepoBinderStore,
): Promise<BatchRowValidation[]> {
  const existingBranches = new Set(inspection.branches);
  const existingWorktreePaths = new Set<string>();

  for (const record of store.worktrees) {
    if (record.deletedAt) {
      continue;
    }

    existingWorktreePaths.add(path.resolve(record.worktreePath));

    if (record.realWorktreePath) {
      existingWorktreePaths.add(path.resolve(record.realWorktreePath));
    }
  }

  const seenBranches = new Set<string>();
  const seenPaths = new Set<string>();
  const validations: BatchRowValidation[] = [];

  for (const row of rows) {
    const errors: string[] = [];

    if (!(await isValidGitBranchName(row.branchName))) {
      errors.push(`Invalid Branch name: ${row.branchName}`);
    }

    if (seenBranches.has(row.branchName)) {
      errors.push(`Duplicate Branch name in this batch: ${row.branchName}`);
    } else {
      seenBranches.add(row.branchName);
    }

    if (existingBranches.has(row.branchName)) {
      errors.push(`Branch already exists: ${row.branchName}`);
    }

    const resolvedPath = path.resolve(row.worktreePath);

    if (seenPaths.has(resolvedPath)) {
      errors.push(`Two rows generate the same Worktree Path: ${row.worktreePath}`);
    } else {
      seenPaths.add(resolvedPath);
    }

    if (existingWorktreePaths.has(resolvedPath)) {
      errors.push(`A tracked Worktree already uses this path: ${row.worktreePath}`);
    }

    if (await pathExists(resolvedPath)) {
      errors.push(`Worktree Path already exists on disk: ${row.worktreePath}`);
    }

    validations.push({ ...row, errors });
  }

  return validations;
}

function slugifyBranchName(branch: string): string {
  const slug = branch
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");

  return slug || "worktree";
}

async function isValidGitBranchName(branchName: string): Promise<boolean> {
  if (/[\0\r\n]/.test(branchName)) {
    return false;
  }

  try {
    await execFileAsync("git", ["check-ref-format", `refs/heads/${branchName}`], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await runGit(worktreePath, ["status", "--porcelain"]);
  return stdout.trim().length > 0;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
