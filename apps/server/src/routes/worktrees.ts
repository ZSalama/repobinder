import { Router } from "express";

import { buildWorktreeResources } from "../resources";
import { localStore, recordOperationSafely } from "../context";
import { toApiError } from "../lib/errors";
import { compactJsonObject } from "../lib/json";
import { isRecord, readOptionalQueryString, readOptionalString, readRequiredString, readResourceOptions } from "../lib/request";
import { inspectRepository } from "../git/inspection";
import { buildAddWorktreeArgs } from "../git/worktrees";
import { runGit } from "../git/exec";
import { broadcast } from "../sockets";

export const worktreesRouter = Router();

worktreesRouter.get("/api/worktrees", async (request, response, next) => {
  try {
    const store = await localStore.read();
    const options = readResourceOptions(request);
    const repositoryId = readOptionalQueryString(request, "repositoryId");
    const worktrees = buildWorktreeResources(store, options).filter(
      (worktree) => !repositoryId || worktree.repositoryId === repositoryId,
    );

    response.json({ worktrees });
  } catch (error) {
    next(error);
  }
});

worktreesRouter.post("/api/worktrees", async (request, response, next) => {
  const requestedRepositoryPath = readOptionalString(request.body, "repositoryPath");
  const requestedWorktreePath = readOptionalString(request.body, "worktreePath");
  const requestedBranchName = readOptionalString(request.body, "branchName");
  const requestedBaseRef = readOptionalString(request.body, "baseRef");
  const requestedCreateBranch = isRecord(request.body) ? Boolean(request.body.createBranch) : false;

  try {
    const repositoryPath = readRequiredString(request.body, "repositoryPath");
    const worktreePath = readRequiredString(request.body, "worktreePath");
    const branchName = readOptionalString(request.body, "branchName");
    const baseRef = readOptionalString(request.body, "baseRef");
    const createBranch = isRecord(request.body) ? Boolean(request.body.createBranch) : false;
    const inspection = await inspectRepository(repositoryPath);
    const args = buildAddWorktreeArgs(worktreePath, branchName, baseRef, createBranch);

    await runGit(inspection.repositoryPath, args);
    const nextInspection = await inspectRepository(inspection.repositoryPath);
    await recordOperationSafely({
      type: "worktree.create",
      status: "success",
      severity: "success",
      summary: "Linked Worktree created",
      details: compactJsonObject({
        repositoryPath: inspection.repositoryPath,
        worktreePath,
        branchName,
        baseRef,
        createBranch,
      }),
    });
    broadcast({
      type: "worktrees.changed",
      repositoryPath: inspection.repositoryPath,
      action: "created",
    });

    response.status(201).json(nextInspection);
  } catch (error) {
    await recordOperationSafely({
      type: "worktree.create",
      status: "failed",
      severity: "error",
      summary: "Linked Worktree creation failed",
      details: compactJsonObject({
        repositoryPath: requestedRepositoryPath,
        worktreePath: requestedWorktreePath,
        branchName: requestedBranchName,
        baseRef: requestedBaseRef,
        createBranch: requestedCreateBranch,
        error: toApiError(error).message,
      }),
    });
    next(error);
  }
});

worktreesRouter.post("/api/worktrees/remove", async (request, response, next) => {
  const requestedRepositoryPath = readOptionalString(request.body, "repositoryPath");
  const requestedWorktreePath = readOptionalString(request.body, "worktreePath");
  const requestedForce = isRecord(request.body) ? Boolean(request.body.force) : false;

  try {
    const repositoryPath = readRequiredString(request.body, "repositoryPath");
    const worktreePath = readRequiredString(request.body, "worktreePath");
    const force = isRecord(request.body) ? Boolean(request.body.force) : false;
    const inspection = await inspectRepository(repositoryPath);
    const args = ["worktree", "remove"];

    if (force) {
      args.push("--force");
    }

    args.push(worktreePath);
    await runGit(inspection.repositoryPath, args);

    const nextInspection = await inspectRepository(inspection.repositoryPath);
    await recordOperationSafely({
      type: "worktree.remove",
      status: "success",
      severity: "success",
      summary: "Linked Worktree removed",
      details: compactJsonObject({
        repositoryPath: inspection.repositoryPath,
        worktreePath,
        force,
      }),
    });
    broadcast({
      type: "worktrees.changed",
      repositoryPath: inspection.repositoryPath,
      action: "removed",
    });

    response.json(nextInspection);
  } catch (error) {
    await recordOperationSafely({
      type: "worktree.remove",
      status: "failed",
      severity: "error",
      summary: "Linked Worktree removal failed",
      details: compactJsonObject({
        repositoryPath: requestedRepositoryPath,
        worktreePath: requestedWorktreePath,
        force: requestedForce,
        error: toApiError(error).message,
      }),
    });
    next(error);
  }
});
