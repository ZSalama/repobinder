import fs from "node:fs/promises";
import path from "node:path";

import { Router } from "express";

import { buildAppStateResource } from "../resources";
import { findVisibleRepository, localStore, recordOperationSafely, runExclusiveMutation } from "../context";
import { ApiError, toApiError } from "../lib/errors";
import { compactJsonObject, nowIso } from "../lib/json";
import {
  argsContainPort,
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
