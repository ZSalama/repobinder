import fs from "node:fs/promises";
import path from "node:path";

import { ApiError } from "../lib/errors";
import { RepositoryInspection, Worktree } from "../lib/types";
import { runGit } from "./exec";

export async function inspectRepository(inputPath: string): Promise<RepositoryInspection> {
  const requestedPath = path.resolve(inputPath);

  try {
    await fs.access(requestedPath);
  } catch {
    throw new ApiError(404, `Path does not exist: ${requestedPath}`);
  }

  const isBareRepository = (await runGit(requestedPath, ["rev-parse", "--is-bare-repository"])).stdout.trim() === "true";

  if (isBareRepository) {
    throw new ApiError(400, "Bare repositories are not supported");
  }

  const root = (await runGit(requestedPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const gitDir = resolveGitPath(root, (await runGit(root, ["rev-parse", "--git-dir"])).stdout.trim());
  const gitCommonDir = resolveGitPath(root, (await runGit(root, ["rev-parse", "--git-common-dir"])).stdout.trim());
  const worktreeOutput = (await runGit(root, ["worktree", "list", "--porcelain"])).stdout;
  const branchOutput = (await runGit(root, ["branch", "--format=%(refname:short)"])).stdout;
  const worktrees = await addRealPaths(parseWorktreePorcelain(worktreeOutput));

  return {
    repositoryPath: root,
    realRepositoryPath: await fs.realpath(root),
    gitDir,
    realGitDir: await fs.realpath(gitDir),
    gitCommonDir,
    realGitCommonDir: await fs.realpath(gitCommonDir),
    worktrees,
    branches: branchOutput
      .split("\n")
      .map((branch) => branch.trim())
      .filter(Boolean),
  };
}

export async function assertPrimaryWorktreeInput(inputPath: string, inspection: RepositoryInspection): Promise<void> {
  const realInputPath = await fs.realpath(path.resolve(inputPath));

  if (realInputPath !== inspection.realRepositoryPath) {
    throw new ApiError(400, "Add Repository requires the Primary Worktree root, not a nested path");
  }

  if (inspection.realGitDir !== inspection.realGitCommonDir) {
    throw new ApiError(400, "Add Repository accepts Primary Worktree paths, not Linked Worktrees");
  }

  const inspectedWorktree = findInspectedWorktree(inspection, inspection.realRepositoryPath);

  if (!inspectedWorktree || inspectedWorktree.bare) {
    throw new ApiError(400, "Add Repository requires a non-bare Primary Worktree");
  }
}

export async function assertExistingLinkedWorktreeInput(
  inputPath: string,
  inspection: RepositoryInspection,
  expectedGitCommonDir: string,
): Promise<void> {
  const realInputPath = await fs.realpath(path.resolve(inputPath));

  if (realInputPath !== inspection.realRepositoryPath) {
    throw new ApiError(400, "Add Existing Worktree requires a Worktree root, not a nested path");
  }

  if (inspection.realGitCommonDir !== expectedGitCommonDir) {
    throw new ApiError(400, "Linked Worktree is not attached to the selected Repository");
  }

  if (inspection.realGitDir === inspection.realGitCommonDir) {
    throw new ApiError(400, "Primary Worktrees cannot be added as existing Linked Worktrees");
  }

  const inspectedWorktree = findInspectedWorktree(inspection, inspection.realRepositoryPath);

  if (!inspectedWorktree || inspectedWorktree.bare) {
    throw new ApiError(400, "Add Existing Worktree requires a non-bare Linked Worktree");
  }
}

export function parseWorktreePorcelain(output: string): Worktree[] {
  return output
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((entry) => {
      const worktree: Worktree = {
        path: "",
        detached: false,
        bare: false,
      };

      for (const line of entry.split("\n")) {
        const separator = line.indexOf(" ");
        const key = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? "" : line.slice(separator + 1);

        switch (key) {
          case "worktree":
            worktree.path = value;
            break;
          case "HEAD":
            worktree.head = value;
            break;
          case "branch":
            worktree.branch = value.replace(/^refs\/heads\//, "");
            break;
          case "bare":
            worktree.bare = true;
            break;
          case "detached":
            worktree.detached = true;
            break;
          case "locked":
            worktree.locked = value || "locked";
            break;
          case "prunable":
            worktree.prunable = value || "prunable";
            break;
        }
      }

      return worktree;
    });
}

export async function addRealPaths(worktrees: Worktree[]): Promise<Worktree[]> {
  return Promise.all(
    worktrees.map(async (worktree) => ({
      ...worktree,
      realPath: await fs.realpath(worktree.path).catch(() => undefined),
    })),
  );
}

export function findInspectedWorktree(inspection: RepositoryInspection, realWorktreePath: string): Worktree | undefined {
  return inspection.worktrees.find((worktree) => worktree.realPath === realWorktreePath);
}

function resolveGitPath(repositoryPath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? path.resolve(gitPath) : path.resolve(repositoryPath, gitPath);
}
