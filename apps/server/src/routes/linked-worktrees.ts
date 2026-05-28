import fs from "node:fs/promises";
import path from "node:path";

import { Router } from "express";

import { buildAppStateResource } from "../resources";
import { findVisibleRepository, localStore, recordOperationSafely, runExclusiveMutation } from "../context";
import { ApiError, toApiError } from "../lib/errors";
import { compactJsonObject, nowIso } from "../lib/json";
import {
  argsContainPort,
  isRecord,
  readNewWorktreeRequest,
  readOptionalString,
  readRequiredString,
  readRouteParam,
  requireDesktopAuth,
} from "../lib/request";
import { assertExistingLinkedWorktreeInput, findInspectedWorktree, inspectRepository } from "../git/inspection";
import { createWorktreeRecord, isWorktreeDirty, resolveBatchRows, validateBatchRows } from "../git/worktrees";
import { runGit } from "../git/exec";
import { reserveBatchPorts, runSetupScript, SetupRunResult, TrackedProcessInput } from "../setup/run";
import { probeDevServerStatus, probeProcessStatus } from "../setup/devserver";
import { stopProcessTree, StopProcessTreeResult } from "../setup/processes";
import { broadcast } from "../sockets";
import {
  appendOperationRecord,
  createDefaultRepositorySettings,
  createRecordId,
  DevServerStatus,
  JsonValue,
  TrackedProcessStatus,
  WorktreeRecord,
} from "../store";

type CreatedRecord = {
  worktreeId: string;
  branchName: string;
  worktreePath: string;
  realWorktreePath: string;
  head?: string;
  locked?: string;
  prunable?: string;
  reservedPort?: number;
  setup?: SetupRunResult;
  devServer?: WorktreeRecord["devServer"];
  trackedProcesses: { input: TrackedProcessInput; status: TrackedProcessStatus }[];
};

type RowOutcome = {
  index: number;
  branchName: string;
  worktreePath: string;
  status: "created" | "failed";
  error?: string;
  reservedPort?: number;
  setup?: SetupRunResult;
  devServerStatus?: DevServerStatus;
};

type ProcessStopOutcome = StopProcessTreeResult & {
  processRecordId: string;
  role: string;
};

type WorktreeRemoveOutcome =
  | { status: "removed" }
  | { status: "already_missing" }
  | { status: "failed"; error: string };

type PruneOutcome = { status: "not_needed" } | { status: "pruned" } | { status: "failed"; error: string };

type BranchDeleteOutcome =
  | { status: "not_requested" }
  | { status: "skipped"; reason: string }
  | { status: "deleted"; branch: string }
  | { status: "failed"; branch: string; error: string };

type SoftDeleteOutcome = { status: "applied" } | { status: "not_applied"; reason: string };

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

linkedWorktreesRouter.delete("/api/repositories/:repositoryId/worktrees/:worktreeId", async (request, response, next) => {
  const repositoryId = readRouteParam(request, "repositoryId");
  const worktreeId = readRouteParam(request, "worktreeId");
  const requestedDeleteBranch =
    isRecord(request.body) && typeof request.body.deleteBranch === "boolean" ? request.body.deleteBranch : undefined;

  try {
    const result = await runExclusiveMutation("worktree.delete", async () => {
      const store = await localStore.read();
      const repository = findVisibleRepository(store, repositoryId);
      const worktree = findVisibleWorktree(store, repositoryId, worktreeId);

      if (worktree.type !== "linked") {
        throw new ApiError(400, "Primary Worktrees cannot be deleted");
      }

      const deleteBranch = requestedDeleteBranch ?? worktree.createdByRepoBinder;
      const trackedProcesses = store.trackedProcesses.filter(
        (processRecord) => processRecord.repositoryId === repositoryId && processRecord.worktreeId === worktreeId,
      );
      const processStops: ProcessStopOutcome[] = [];

      for (const processRecord of trackedProcesses) {
        processStops.push({
          ...(await stopProcessTree(processRecord.pid)),
          processRecordId: processRecord.processRecordId,
          role: processRecord.role,
        });
      }

      const removeOutcome = await removeLinkedWorktree(repository.primaryWorktreePath, worktree);
      const pruneOutcome: PruneOutcome =
        removeOutcome.status === "already_missing" ? await pruneWorktrees(repository.primaryWorktreePath) : { status: "not_needed" };
      const branchOutcome =
        removeOutcome.status === "failed"
          ? ({ status: "not_requested" } as const)
          : await deleteBranchSafely(repository.primaryWorktreePath, worktree.branch, deleteBranch);
      const hardFailed = removeOutcome.status === "failed";
      const softDeleteOutcome: SoftDeleteOutcome = hardFailed
        ? { status: "not_applied", reason: "Worktree removal failed" }
        : { status: "applied" };
      const status = hardFailed
        ? "failed"
        : hasDeleteWarnings(processStops, pruneOutcome, branchOutcome)
          ? "warning"
          : "success";
      const summary = buildDeleteSummary(removeOutcome, branchOutcome, processStops, pruneOutcome);

      const state = await localStore.update((mutableStore) => {
        const timestamp = nowIso();
        const mutableRepository = findVisibleRepository(mutableStore, repositoryId);
        const mutableWorktree = findVisibleWorktree(mutableStore, repositoryId, worktreeId);

        for (const processStop of processStops) {
          const mutableProcess = mutableStore.trackedProcesses.find(
            (record) => record.processRecordId === processStop.processRecordId,
          );

          if (!mutableProcess) {
            continue;
          }

          mutableProcess.status = processStop.status === "failed" ? "failed" : "stopped";
          mutableProcess.updatedAt = timestamp;

          if (mutableProcess.status === "stopped" && !mutableProcess.stoppedAt) {
            mutableProcess.stoppedAt = timestamp;
          }
        }

        if (!hardFailed) {
          mutableWorktree.deletedAt = timestamp;
          mutableWorktree.updatedAt = timestamp;
          mutableWorktree.availability = "missing";

          if (mutableWorktree.devServer) {
            mutableWorktree.devServer = {
              ...mutableWorktree.devServer,
              status: "stopped",
              updatedAt: timestamp,
            };
          }

          if (mutableStore.selection.worktreeId === worktreeId) {
            mutableStore.selection = {
              repositoryId,
              worktreeId: mutableRepository.primaryWorktreeId,
              updatedAt: timestamp,
            };
          }

          mutableRepository.updatedAt = timestamp;
        }

        appendOperationRecord(mutableStore, {
          type: "worktree.delete",
          status,
          severity: status === "failed" ? "error" : status,
          summary,
          repositoryId,
          worktreeId,
          details: compactJsonObject({
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            deleteBranch,
            worktreeRemove: removeOutcome as unknown as JsonValue,
            prune: pruneOutcome as unknown as JsonValue,
            branchDelete: branchOutcome as unknown as JsonValue,
            softDelete: softDeleteOutcome as unknown as JsonValue,
            processStops: processStops.map((processStop) =>
              compactJsonObject({
                processRecordId: processStop.processRecordId,
                role: processStop.role,
                pid: processStop.pid,
                status: processStop.status,
                forceUsed: processStop.forceUsed,
                descendants: processStop.descendants as JsonValue,
                error: processStop.error,
              }),
            ) as JsonValue,
          }),
        });

        return buildAppStateResource(mutableStore);
      });

      if (hardFailed) {
        throw markOperationRecorded(new ApiError(400, removeOutcome.error));
      }

      return {
        state,
        result: {
          status,
          summary,
          deleteBranch,
          worktreeRemove: removeOutcome,
          prune: pruneOutcome,
          branchDelete: branchOutcome,
          softDelete: softDeleteOutcome,
          processStops,
        },
      };
    });

    broadcast({ type: "state.changed", reason: "worktree.delete" });
    response.json(result);
  } catch (error) {
    if (isOperationRecordedError(error)) {
      broadcast({ type: "state.changed", reason: "worktree.delete" });
    } else {
      await recordOperationSafely({
        type: "worktree.delete",
        status: "failed",
        severity: "error",
        summary: "Linked Worktree deletion failed",
        repositoryId,
        worktreeId,
        details: compactJsonObject({
          deleteBranch: requestedDeleteBranch,
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
    const settings =
      store.repositorySettings.find((record) => record.repositoryId === repositoryId) ??
      createDefaultRepositorySettings(repositoryId);

    response.json({
      repositoryId,
      primaryWorktreePath: repository.primaryWorktreePath,
      baseBranch: detached ? undefined : primaryEntry?.branch,
      detached,
      dirty,
      setupEnabled: settings.setup.enabled,
      autoStartDevServer: settings.setup.enabled && settings.setup.autoStartDevServer,
    });
  } catch (error) {
    next(error);
  }
});

linkedWorktreesRouter.post("/api/repositories/:repositoryId/worktrees", async (request, response, next) => {
  const repositoryId = readRouteParam(request, "repositoryId");

  try {
    const { names, rowArgs, sharedArgs } = readNewWorktreeRequest(request.body);
    const store = await localStore.read();
    const repository = findVisibleRepository(store, repositoryId);
    const inspection = await inspectRepository(repository.primaryWorktreePath);
    const primaryEntry = findInspectedWorktree(inspection, inspection.realRepositoryPath);

    if (!primaryEntry || primaryEntry.detached || !primaryEntry.branch) {
      throw new ApiError(400, "New Worktree requires the Primary Worktree to have a checked-out Branch");
    }

    const settings =
      store.repositorySettings.find((record) => record.repositoryId === repositoryId) ??
      createDefaultRepositorySettings(repositoryId);
    const setupEnabled = settings.setup.enabled && Boolean(settings.setup.command);
    const autoStartDevServer = setupEnabled && settings.setup.autoStartDevServer;

    if (autoStartDevServer) {
      if (argsContainPort(sharedArgs)) {
        throw new ApiError(400, "Shared run args cannot include --port when Auto Start Dev Server is enabled");
      }

      rowArgs.forEach((args, index) => {
        if (argsContainPort(args)) {
          throw new ApiError(400, `Row ${index + 1} args cannot include --port when Auto Start Dev Server is enabled`);
        }
      });
    }

    const baseBranch = primaryEntry.branch;
    const resolvedRows = resolveBatchRows(names, repository.primaryWorktreePath);
    const validation = await validateBatchRows(resolvedRows, inspection, store);

    if (validation.some((row) => row.errors.length > 0)) {
      await recordOperationSafely({
        type: "worktree.create-batch",
        status: "failed",
        severity: "error",
        summary: "New Worktree validation failed",
        repositoryId,
        details: compactJsonObject({
          baseBranch,
          rows: validation.map((row) =>
            compactJsonObject({
              branchName: row.branchName,
              worktreePath: row.worktreePath,
              errors: row.errors as JsonValue,
            }),
          ) as JsonValue,
        }),
      });
      response.status(400).json({ error: "New Worktree validation failed", rows: validation });
      return;
    }

    const dirty = await isWorktreeDirty(repository.primaryWorktreePath);

    const result = await runExclusiveMutation("worktree.create-batch", async () => {
      // Reserve all ports for the batch before any Git creation starts.
      const reservedPorts = autoStartDevServer ? await reserveBatchPorts(resolvedRows.length) : [];
      const outcomes: RowOutcome[] = [];

      // Run Git creation and the Worktree Setup Script sequentially per row.
      for (const row of resolvedRows) {
        const reservedPort = autoStartDevServer ? reservedPorts[row.index] : undefined;

        try {
          await runGit(inspection.repositoryPath, ["worktree", "add", "-b", row.branchName, row.worktreePath, baseBranch]);
        } catch (error) {
          outcomes.push({
            index: row.index,
            branchName: row.branchName,
            worktreePath: row.worktreePath,
            status: "failed",
            error: toApiError(error).message,
          });
          continue;
        }

        let setup: SetupRunResult | undefined;
        let devServerStatus: DevServerStatus | undefined;

        if (setupEnabled && settings.setup.command) {
          const args = [
            ...settings.setup.defaultArgs,
            ...sharedArgs,
            ...(rowArgs[row.index] ?? []),
            ...(reservedPort !== undefined ? ["--port", String(reservedPort)] : []),
          ];

          // The setup script runs inside the new Linked Worktree.
          setup = await runSetupScript({ command: settings.setup.command, args, cwd: row.worktreePath });

          if (setup.devServer) {
            devServerStatus = await probeDevServerStatus(setup.devServer);
          }
        }

        outcomes.push({
          index: row.index,
          branchName: row.branchName,
          worktreePath: row.worktreePath,
          status: "created",
          reservedPort,
          setup,
          devServerStatus,
        });
      }

      const postInspection = await inspectRepository(inspection.repositoryPath);
      const createdRecords: CreatedRecord[] = await Promise.all(
        outcomes
          .filter((outcome) => outcome.status === "created")
          .map(async (outcome) => {
            const resolvedPath = path.resolve(outcome.worktreePath);
            const realWorktreePath = await fs.realpath(resolvedPath).catch(() => resolvedPath);
            const entry =
              postInspection.worktrees.find((worktree) => worktree.realPath === realWorktreePath) ??
              postInspection.worktrees.find((worktree) => path.resolve(worktree.path) === resolvedPath);
            const devServer = outcome.setup?.devServer
              ? {
                  ...outcome.setup.devServer,
                  status: outcome.devServerStatus ?? "unknown",
                  updatedAt: nowIso(),
                }
              : undefined;
            const trackedProcesses = (outcome.setup?.trackedProcesses ?? []).map((input) => ({
              input,
              status: probeProcessStatus(input.pid),
            }));

            return {
              worktreeId: createRecordId("worktree"),
              branchName: outcome.branchName,
              worktreePath: outcome.worktreePath,
              realWorktreePath,
              head: entry?.head,
              locked: entry?.locked,
              prunable: entry?.prunable,
              reservedPort: outcome.reservedPort,
              setup: outcome.setup,
              devServer,
              trackedProcesses,
            };
          }),
      );

      const createdCount = createdRecords.length;
      const gitFailedCount = outcomes.length - createdCount;
      const setupFailedCount = createdRecords.filter((record) => record.setup?.status === "failed").length;
      const setupWarningCount = createdRecords.filter((record) => record.setup?.status === "warning").length;
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
              setupStatus: record.setup ? record.setup.status : "skipped",
              setupWarnings: record.setup?.warnings,
              setupLastExitCode: record.setup?.exitCode ?? undefined,
              devServer: record.devServer,
              timestamp,
            }),
          );

          for (const tracked of record.trackedProcesses) {
            mutableStore.trackedProcesses.push({
              processRecordId: createRecordId("process"),
              repositoryId,
              worktreeId: record.worktreeId,
              role: tracked.input.role,
              status: tracked.status,
              pid: tracked.input.pid,
              command: tracked.input.command,
              args: tracked.input.args,
              cwd: record.worktreePath,
              url: tracked.input.url,
              port: tracked.input.port,
              startedAt: timestamp,
              lastSeenAt: tracked.status === "running" ? timestamp : undefined,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          }
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

        const hasIssues = gitFailedCount > 0 || setupFailedCount > 0 || setupWarningCount > 0;
        const status = createdCount === 0 ? "failed" : hasIssues ? "warning" : "success";
        const severity = createdCount === 0 ? "error" : hasIssues ? "warning" : "success";
        const summary = buildBatchSummary({
          requested: outcomes.length,
          createdCount,
          gitFailedCount,
          setupFailedCount,
          setupWarningCount,
        });

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
            failed: gitFailedCount,
            setupFailed: setupFailedCount,
            setupWarning: setupWarningCount,
            dirty,
            warnings: warnings as JsonValue,
            rows: outcomes.map((outcome) =>
              compactJsonObject({
                branchName: outcome.branchName,
                worktreePath: outcome.worktreePath,
                status: outcome.status,
                error: outcome.error,
                reservedPort: outcome.reservedPort,
                setupStatus: outcome.setup?.status,
                setupExitCode: outcome.setup?.exitCode ?? undefined,
                setupWarnings: (outcome.setup?.warnings ?? []) as JsonValue,
                devServerStatus: outcome.devServerStatus,
                devServerUrl: outcome.setup?.devServer?.url,
                devServerPort: outcome.setup?.devServer?.port,
              }),
            ) as JsonValue,
          }),
        });

        return buildAppStateResource(mutableStore);
      });

      return { state, outcomes, createdCount, gitFailedCount, warnings };
    });

    broadcast({ type: "state.changed", reason: "worktree.create-batch" });
    response.status(201).json({
      state: result.state,
      result: {
        baseBranch,
        dirty,
        created: result.createdCount,
        failed: result.gitFailedCount,
        warnings: result.warnings,
        rows: result.outcomes.map((outcome) => ({
          index: outcome.index,
          branchName: outcome.branchName,
          worktreePath: outcome.worktreePath,
          status: outcome.status,
          error: outcome.error,
          reservedPort: outcome.reservedPort,
          devServerStatus: outcome.devServerStatus,
          setup: outcome.setup
            ? {
                status: outcome.setup.status,
                exitCode: outcome.setup.exitCode,
                durationMs: outcome.setup.durationMs,
                timedOut: outcome.setup.timedOut,
                truncated: outcome.setup.truncated,
                metadataParsed: outcome.setup.metadataParsed,
                warnings: outcome.setup.warnings,
                stdout: outcome.setup.stdout,
                stderr: outcome.setup.stderr,
                devServer: outcome.setup.devServer,
              }
            : undefined,
        })),
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

function buildBatchSummary(input: {
  requested: number;
  createdCount: number;
  gitFailedCount: number;
  setupFailedCount: number;
  setupWarningCount: number;
}): string {
  if (input.createdCount === 0) {
    return "No Linked Worktrees were created";
  }

  const base =
    input.gitFailedCount === 0
      ? `Created ${input.createdCount} Linked Worktree${input.createdCount === 1 ? "" : "s"}`
      : `Created ${input.createdCount} of ${input.requested} Linked Worktrees`;

  const notes: string[] = [];

  if (input.setupFailedCount > 0) {
    notes.push(`${input.setupFailedCount} setup failed`);
  }

  if (input.setupWarningCount > 0) {
    notes.push(`${input.setupWarningCount} setup warning${input.setupWarningCount === 1 ? "" : "s"}`);
  }

  return notes.length > 0 ? `${base} (${notes.join(", ")})` : base;
}

function findVisibleWorktree(store: { worktrees: WorktreeRecord[] }, repositoryId: string, worktreeId: string): WorktreeRecord {
  const worktree = store.worktrees.find(
    (record) => record.worktreeId === worktreeId && record.repositoryId === repositoryId && !record.deletedAt,
  );

  if (!worktree) {
    throw new ApiError(404, `Worktree Record not found: ${worktreeId}`);
  }

  return worktree;
}

async function removeLinkedWorktree(repositoryPath: string, worktree: WorktreeRecord): Promise<WorktreeRemoveOutcome> {
  if (!(await worktreePathExists(worktree))) {
    return { status: "already_missing" };
  }

  try {
    await runGit(repositoryPath, ["worktree", "remove", worktree.worktreePath]);
    return { status: "removed" };
  } catch (error) {
    return { status: "failed", error: toApiError(error).message };
  }
}

async function pruneWorktrees(repositoryPath: string): Promise<PruneOutcome> {
  try {
    await runGit(repositoryPath, ["worktree", "prune"]);
    return { status: "pruned" };
  } catch (error) {
    return { status: "failed", error: toApiError(error).message };
  }
}

async function deleteBranchSafely(
  repositoryPath: string,
  branch: string | undefined,
  deleteBranch: boolean,
): Promise<BranchDeleteOutcome> {
  if (!deleteBranch) {
    return { status: "not_requested" };
  }

  if (!branch) {
    return { status: "skipped", reason: "Worktree has no Branch" };
  }

  try {
    await runGit(repositoryPath, ["branch", "-d", branch]);
    return { status: "deleted", branch };
  } catch (error) {
    return { status: "failed", branch, error: toApiError(error).message };
  }
}

async function worktreePathExists(worktree: WorktreeRecord): Promise<boolean> {
  return (await pathExists(worktree.worktreePath)) || (await pathExists(worktree.realWorktreePath));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hasDeleteWarnings(
  processStops: ProcessStopOutcome[],
  pruneOutcome: PruneOutcome,
  branchOutcome: BranchDeleteOutcome,
): boolean {
  return (
    processStops.some((processStop) => processStop.status === "failed") ||
    pruneOutcome.status === "failed" ||
    branchOutcome.status === "failed"
  );
}

function buildDeleteSummary(
  removeOutcome: WorktreeRemoveOutcome,
  branchOutcome: BranchDeleteOutcome,
  processStops: ProcessStopOutcome[],
  pruneOutcome: PruneOutcome,
): string {
  if (removeOutcome.status === "failed") {
    return "Linked Worktree deletion failed";
  }

  const base =
    removeOutcome.status === "already_missing" ? "Linked Worktree was already removed" : "Linked Worktree removed";
  const withBranch = branchOutcome.status === "deleted" ? `${base} and Branch deleted` : base;
  const notes: string[] = [];
  const failedProcessCount = processStops.filter((processStop) => processStop.status === "failed").length;

  if (failedProcessCount > 0) {
    notes.push(`${failedProcessCount} process cleanup failure${failedProcessCount === 1 ? "" : "s"}`);
  }

  if (pruneOutcome.status === "failed") {
    notes.push("Git worktree prune failed");
  }

  if (branchOutcome.status === "failed") {
    notes.push("Branch delete failed");
  }

  return notes.length > 0 ? `${withBranch} (${notes.join(", ")})` : withBranch;
}

function markOperationRecorded(error: ApiError): ApiError & { operationRecorded: true } {
  return Object.assign(error, { operationRecorded: true as const });
}

function isOperationRecordedError(error: unknown): error is ApiError & { operationRecorded: true } {
  return error instanceof ApiError && "operationRecorded" in error;
}
