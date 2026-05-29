import path from "node:path";

import { Router } from "express";

import {
  buildAppStateResource,
  buildRepositoryResource,
  buildRepositoryResources,
  buildWorktreeResources,
} from "../resources";
import { localStore, recordOperationSafely, runExclusiveMutation } from "../context";
import { ApiError, toApiError } from "../lib/errors";
import { compactJsonObject, nowIso } from "../lib/json";
import {
  readOptionalString,
  readRequiredString,
  readResourceOptions,
  readRouteParam,
  requireDesktopAuth,
} from "../lib/request";
import { assertPrimaryWorktreeInput, findInspectedWorktree, inspectRepository } from "../git/inspection";
import { createWorktreeRecord } from "../git/worktrees";
import { broadcast } from "../sockets";
import { appendOperationRecord, createDefaultRepositorySettings, createRecordId } from "../store";

export const repositoriesRouter = Router();

repositoriesRouter.get("/api/repositories", async (request, response, next) => {
  try {
    const store = await localStore.read();
    response.json({ repositories: buildRepositoryResources(store, readResourceOptions(request)) });
  } catch (error) {
    next(error);
  }
});

repositoriesRouter.post("/api/repositories", async (request, response, next) => {
  const requestedRepositoryPath = readOptionalString(request.body, "repositoryPath");

  try {
    requireDesktopAuth(request);

    const repositoryPath = readRequiredString(request.body, "repositoryPath");
    const inspection = await inspectRepository(repositoryPath);

    await assertPrimaryWorktreeInput(repositoryPath, inspection);

    const result = await runExclusiveMutation("repository.add", async () => {
      let created = false;
      const state = await localStore.update((store) => {
        const timestamp = nowIso();
        const duplicateRepository = store.repositories.find(
          (repository) =>
            !repository.deletedAt &&
            repository.realPrimaryWorktreePath === inspection.realRepositoryPath &&
            repository.gitCommonDir === inspection.realGitCommonDir,
        );

        if (duplicateRepository) {
          store.selection = {
            repositoryId: duplicateRepository.repositoryId,
            worktreeId: duplicateRepository.primaryWorktreeId,
            updatedAt: timestamp,
          };
          duplicateRepository.updatedAt = timestamp;
          appendOperationRecord(store, {
            type: "repository.add",
            status: "success",
            severity: "info",
            summary: "Repository already tracked",
            repositoryId: duplicateRepository.repositoryId,
            worktreeId: duplicateRepository.primaryWorktreeId,
            details: compactJsonObject({
              repositoryPath: inspection.repositoryPath,
            }),
          });

          return buildAppStateResource(store);
        }

        const repositoryId = createRecordId("repository");
        const primaryWorktreeId = createRecordId("worktree");
        const primaryWorktree = findInspectedWorktree(inspection, inspection.realRepositoryPath);
        const repository = {
          repositoryId,
          displayName: path.basename(inspection.repositoryPath),
          primaryWorktreeId,
          primaryWorktreePath: inspection.repositoryPath,
          realPrimaryWorktreePath: inspection.realRepositoryPath,
          gitCommonDir: inspection.realGitCommonDir,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const worktree = createWorktreeRecord({
          worktreeId: primaryWorktreeId,
          repositoryId,
          type: "primary",
          worktreePath: inspection.repositoryPath,
          realWorktreePath: inspection.realRepositoryPath,
          gitCommonDir: inspection.realGitCommonDir,
          branch: primaryWorktree?.branch,
          head: primaryWorktree?.head,
          locked: primaryWorktree?.locked,
          prunable: primaryWorktree?.prunable,
          createdByRepoBinder: false,
          setupStatus: "not_configured",
          timestamp,
        });

        store.repositories.push(repository);
        store.repositorySettings.push(createDefaultRepositorySettings(repositoryId, timestamp));
        store.worktrees.push(worktree);
        store.selection = {
          repositoryId,
          worktreeId: primaryWorktreeId,
          updatedAt: timestamp,
        };
        appendOperationRecord(store, {
          type: "repository.add",
          status: "success",
          severity: "success",
          summary: "Repository added",
          repositoryId,
          worktreeId: primaryWorktreeId,
          details: compactJsonObject({
            repositoryPath: inspection.repositoryPath,
          }),
        });
        created = true;

        return buildAppStateResource(store);
      });

      return { created, state };
    });

    broadcast({ type: "state.changed", reason: "repository.add" });
    response.status(result.created ? 201 : 200).json(result.state);
  } catch (error) {
    if (!(error instanceof ApiError && error.statusCode === 403)) {
      await recordOperationSafely({
        type: "repository.add",
        status: "failed",
        severity: "error",
        summary: "Repository add failed",
        details: compactJsonObject({
          repositoryPath: requestedRepositoryPath,
          error: toApiError(error).message,
        }),
      });
    }

    next(error);
  }
});

repositoriesRouter.get("/api/repositories/:repositoryId", async (request, response, next) => {
  try {
    const repositoryId = readRouteParam(request, "repositoryId");
    const store = await localStore.read();
    const options = readResourceOptions(request);
    const repository = store.repositories.find(
      (record) => record.repositoryId === repositoryId && (options.includeDeleted || !record.deletedAt),
    );

    if (!repository) {
      throw new ApiError(404, `Repository Record not found: ${repositoryId}`);
    }

    response.json({ repository: buildRepositoryResource(store, repository, options) });
  } catch (error) {
    next(error);
  }
});

repositoriesRouter.get("/api/repositories/:repositoryId/worktrees", async (request, response, next) => {
  try {
    const repositoryId = readRouteParam(request, "repositoryId");
    const store = await localStore.read();
    const options = readResourceOptions(request);
    const repository = store.repositories.find(
      (record) => record.repositoryId === repositoryId && (options.includeDeleted || !record.deletedAt),
    );

    if (!repository) {
      throw new ApiError(404, `Repository Record not found: ${repositoryId}`);
    }

    const worktrees = buildWorktreeResources(store, options).filter((worktree) => worktree.repositoryId === repositoryId);
    response.json({ worktrees });
  } catch (error) {
    next(error);
  }
});
