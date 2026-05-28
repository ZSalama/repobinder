import fs from "node:fs/promises";
import path from "node:path";

import { Router } from "express";

import { buildAppStateResource } from "../resources";
import { findVisibleRepository, localStore, recordOperationSafely, runExclusiveMutation } from "../context";
import { ApiError, toApiError } from "../lib/errors";
import { compactJsonObject, nowIso } from "../lib/json";
import {
  readNewWorktreeRows,
  readOptionalString,
  readRequiredString,
  readRouteParam,
  requireDesktopAuth,
} from "../lib/request";
import { BatchRowOutcome } from "../lib/types";
import { assertExistingLinkedWorktreeInput, findInspectedWorktree, inspectRepository } from "../git/inspection";
import { createWorktreeRecord, isWorktreeDirty, resolveBatchRows, validateBatchRows } from "../git/worktrees";
import { runGit } from "../git/exec";
import { broadcast } from "../sockets";
import { appendOperationRecord, createRecordId, JsonValue } from "../store";

export const linkedWorktreesRouter = Router();

linkedWorktreesRouter.post("/api/repositories/:repositoryId/worktrees/existing", async (request, response, next) => {
  const repositoryId = readRouteParam(request, "repositoryId");
  const requestedWorktreePath = readOptionalString(request.body, "worktreePath");

  try {
    requireDesktopAuth(request);

    const worktreePath = readRequiredString(request.body, "worktreePath");
    const store = await localStore.read();
    const repository = findVisibleRepository(store, repositoryId);
    const inspection = await inspectRepository(worktreePath);

    await assertExistingLinkedWorktreeInput(worktreePath, inspection, repository.gitCommonDir);

    const state = await runExclusiveMutation("worktree.add-existing", async () =>
      localStore.update((mutableStore) => {
        const timestamp = nowIso();
        const mutableRepository = findVisibleRepository(mutableStore, repositoryId);
        const duplicateWorktree = mutableStore.worktrees.find(
          (worktree) =>
            !worktree.deletedAt &&
            worktree.realWorktreePath === inspection.realRepositoryPath &&
            worktree.gitCommonDir === mutableRepository.gitCommonDir,
        );

        if (duplicateWorktree) {
          mutableStore.selection = {
            repositoryId: duplicateWorktree.repositoryId,
            worktreeId: duplicateWorktree.worktreeId,
            updatedAt: timestamp,
          };
          appendOperationRecord(mutableStore, {
            type: "worktree.add-existing",
            status: "success",
            severity: "info",
            summary: "Linked Worktree already tracked",
            repositoryId: duplicateWorktree.repositoryId,
            worktreeId: duplicateWorktree.worktreeId,
            details: compactJsonObject({
              worktreePath: inspection.repositoryPath,
            }),
          });

          return buildAppStateResource(mutableStore);
        }

        const inspectedWorktree = findInspectedWorktree(inspection, inspection.realRepositoryPath);
        const worktreeId = createRecordId("worktree");
        const worktree = createWorktreeRecord({
          worktreeId,
          repositoryId,
          type: "linked",
          worktreePath: inspection.repositoryPath,
          realWorktreePath: inspection.realRepositoryPath,
          gitCommonDir: mutableRepository.gitCommonDir,
          branch: inspectedWorktree?.branch,
          head: inspectedWorktree?.head,
          locked: inspectedWorktree?.locked,
          prunable: inspectedWorktree?.prunable,
          createdByRepoBinder: false,
          setupStatus: "skipped",
          timestamp,
        });

        mutableStore.worktrees.push(worktree);
        mutableRepository.updatedAt = timestamp;
        mutableStore.selection = {
          repositoryId,
          worktreeId,
          updatedAt: timestamp,
        };
        appendOperationRecord(mutableStore, {
          type: "worktree.add-existing",
          status: "success",
          severity: "success",
          summary: "Existing Linked Worktree added",
          repositoryId,
          worktreeId,
          details: compactJsonObject({
            worktreePath: inspection.repositoryPath,
          }),
        });

        return buildAppStateResource(mutableStore);
      }),
    );

    broadcast({ type: "state.changed", reason: "worktree.add-existing" });
    response.status(201).json(state);
  } catch (error) {
    if (!(error instanceof ApiError && error.statusCode === 403)) {
      await recordOperationSafely({
        type: "worktree.add-existing",
        status: "failed",
        severity: "error",
        summary: "Existing Linked Worktree add failed",
        repositoryId,
        details: compactJsonObject({
          worktreePath: requestedWorktreePath,
          error: toApiError(error).message,
        }),
      });
    }

    next(error);
  }
});

linkedWorktreesRouter.get("/api/repositories/:repositoryId/new-worktree-context", async (request, response, next) => {
  try {
    const repositoryId = readRouteParam(request, "repositoryId");
    const store = await localStore.read();
    const repository = findVisibleRepository(store, repositoryId);
    const inspection = await inspectRepository(repository.primaryWorktreePath);
    const primaryEntry = findInspectedWorktree(inspection, inspection.realRepositoryPath);
    const detached = !primaryEntry || primaryEntry.detached || !primaryEntry.branch;
    const dirty = await isWorktreeDirty(repository.primaryWorktreePath);

    response.json({
      repositoryId,
      primaryWorktreePath: repository.primaryWorktreePath,
      baseBranch: detached ? undefined : primaryEntry?.branch,
      detached,
      dirty,
    });
  } catch (error) {
    next(error);
  }
});

linkedWorktreesRouter.post("/api/repositories/:repositoryId/worktrees", async (request, response, next) => {
  const repositoryId = readRouteParam(request, "repositoryId");

  try {
    const requestedNames = readNewWorktreeRows(request.body);
    const store = await localStore.read();
    const repository = findVisibleRepository(store, repositoryId);
    const inspection = await inspectRepository(repository.primaryWorktreePath);
    const primaryEntry = findInspectedWorktree(inspection, inspection.realRepositoryPath);

    if (!primaryEntry || primaryEntry.detached || !primaryEntry.branch) {
      throw new ApiError(400, "New Worktree requires the Primary Worktree to have a checked-out Branch");
    }

    const baseBranch = primaryEntry.branch;
    const resolvedRows = resolveBatchRows(requestedNames, repository.primaryWorktreePath);
    const validation = await validateBatchRows(resolvedRows, inspection, store);

    if (validation.some((row) => row.errors.length > 0)) {
      response.status(400).json({ error: "New Worktree validation failed", rows: validation });
      return;
    }

    const dirty = await isWorktreeDirty(repository.primaryWorktreePath);

    const result = await runExclusiveMutation("worktree.create-batch", async () => {
      const outcomes: BatchRowOutcome[] = [];

      for (const row of resolvedRows) {
        try {
          await runGit(inspection.repositoryPath, [
            "worktree",
            "add",
            "-b",
            row.branchName,
            row.worktreePath,
            baseBranch,
          ]);
          outcomes.push({ index: row.index, branchName: row.branchName, worktreePath: row.worktreePath, status: "created" });
        } catch (error) {
          outcomes.push({
            index: row.index,
            branchName: row.branchName,
            worktreePath: row.worktreePath,
            status: "failed",
            error: toApiError(error).message,
          });
        }
      }

      const postInspection = await inspectRepository(inspection.repositoryPath);
      const createdRecords = await Promise.all(
        outcomes
          .filter((outcome) => outcome.status === "created")
          .map(async (outcome) => {
            const resolvedPath = path.resolve(outcome.worktreePath);
            const realWorktreePath = await fs.realpath(resolvedPath).catch(() => resolvedPath);
            const entry =
              postInspection.worktrees.find((worktree) => worktree.realPath === realWorktreePath) ??
              postInspection.worktrees.find((worktree) => path.resolve(worktree.path) === resolvedPath);

            return {
              worktreeId: createRecordId("worktree"),
              branchName: outcome.branchName,
              worktreePath: outcome.worktreePath,
              realWorktreePath,
              head: entry?.head,
              locked: entry?.locked,
              prunable: entry?.prunable,
            };
          }),
      );

      const createdCount = createdRecords.length;
      const failedCount = outcomes.length - createdCount;
      const warnings = dirty
        ? ["Primary Worktree had uncommitted changes; they were not copied into the new Linked Worktrees"]
        : [];

      const state = await localStore.update((mutableStore) => {
        const timestamp = nowIso();
        const mutableRepository = findVisibleRepository(mutableStore, repositoryId);

        for (const record of createdRecords) {
          mutableStore.worktrees.push(
            createWorktreeRecord({
              worktreeId: record.worktreeId,
              repositoryId,
              type: "linked",
              worktreePath: record.worktreePath,
              realWorktreePath: record.realWorktreePath,
              gitCommonDir: mutableRepository.gitCommonDir,
              branch: record.branchName,
              head: record.head,
              locked: record.locked,
              prunable: record.prunable,
              createdByRepoBinder: true,
              // Worktree Setup Script execution is implemented in a later phase.
              setupStatus: "skipped",
              timestamp,
            }),
          );
        }

        const firstCreated = createdRecords[0];

        if (firstCreated) {
          mutableStore.selection = {
            repositoryId,
            worktreeId: firstCreated.worktreeId,
            updatedAt: timestamp,
          };
        }

        mutableRepository.updatedAt = timestamp;

        const status = failedCount === 0 ? "success" : createdCount === 0 ? "failed" : "warning";
        const severity = failedCount === 0 ? "success" : createdCount === 0 ? "error" : "warning";
        const summary =
          failedCount === 0
            ? `Created ${createdCount} Linked Worktree${createdCount === 1 ? "" : "s"}`
            : createdCount === 0
              ? "No Linked Worktrees were created"
              : `Created ${createdCount} of ${outcomes.length} Linked Worktrees`;

        appendOperationRecord(mutableStore, {
          type: "worktree.create-batch",
          status,
          severity,
          summary,
          repositoryId,
          worktreeId: createdRecords[0]?.worktreeId,
          details: compactJsonObject({
            baseBranch,
            requested: outcomes.length,
            created: createdCount,
            failed: failedCount,
            dirty,
            warnings: warnings as JsonValue,
            rows: outcomes.map((outcome) =>
              compactJsonObject({
                branchName: outcome.branchName,
                worktreePath: outcome.worktreePath,
                status: outcome.status,
                error: outcome.error,
              }),
            ) as JsonValue,
          }),
        });

        return buildAppStateResource(mutableStore);
      });

      return { state, outcomes, createdCount, failedCount, warnings };
    });

    broadcast({ type: "state.changed", reason: "worktree.create-batch" });
    response.status(201).json({
      state: result.state,
      result: {
        baseBranch,
        dirty,
        created: result.createdCount,
        failed: result.failedCount,
        warnings: result.warnings,
        rows: result.outcomes,
      },
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.statusCode === 409)) {
      await recordOperationSafely({
        type: "worktree.create-batch",
        status: "failed",
        severity: "error",
        summary: "New Worktree batch failed",
        repositoryId,
        details: compactJsonObject({
          error: toApiError(error).message,
        }),
      });
    }

    next(error);
  }
});
