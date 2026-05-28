import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import express, { NextFunction, Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";

import {
  buildAppStateResource,
  buildRepositoryResource,
  buildRepositoryResources,
  buildWorktreeResources,
} from "./resources";
import {
  appendOperationRecord,
  createDefaultRepositorySettings,
  createRecordId,
  CreateOperationInput,
  JsonObject,
  JsonValue,
  LocalJsonStore,
  OPERATION_RETENTION_LIMIT,
  RepositorySettingsRecord,
  RepoBinderStore,
  resolveStorePath,
  SelectionRecord,
  WorktreeRecord,
} from "./store";

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 3773;
const DEFAULT_HOST = "127.0.0.1";
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

type Worktree = {
  path: string;
  realPath?: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
};

type RepositoryInspection = {
  repositoryPath: string;
  realRepositoryPath: string;
  gitDir: string;
  realGitDir: string;
  gitCommonDir: string;
  realGitCommonDir: string;
  worktrees: Worktree[];
  branches: string[];
};

type BatchRow = {
  index: number;
  branchName: string;
  worktreePath: string;
};

type BatchRowValidation = BatchRow & {
  errors: string[];
};

type BatchRowOutcome = BatchRow & {
  status: "created" | "failed";
  error?: string;
};

type SocketMessage =
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

class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const port = parsePort(process.env.PORT);
const host = process.env.HOST || DEFAULT_HOST;
const webDist = path.resolve(process.env.REPOBINDER_WEB_DIST || path.join(process.cwd(), "dist-web"));
const localStore = new LocalJsonStore(resolveStorePath());
const app = express();
const server = http.createServer(app);
const sockets = new WebSocketServer({ noServer: true });
let mutatingOperation: Promise<unknown> | undefined;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.type("text/plain").send("ok");
});

app.get("/api/server", (_request, response) => {
  response.json({
    name: "repobinder",
    host,
    port,
    remoteEnabled: host === "0.0.0.0",
    advertisedUrls: getAdvertisedUrls(host, port),
  });
});

app.get("/api/store/meta", async (_request, response, next) => {
  try {
    const store = await localStore.read();

    response.json({
      schemaVersion: store.schemaVersion,
      storePath: localStore.path,
      operationRetentionLimit: OPERATION_RETENTION_LIMIT,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", async (request, response, next) => {
  try {
    const store = await localStore.read();
    response.json(buildAppStateResource(store, readResourceOptions(request)));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/selection", async (request, response, next) => {
  const repositoryId = readOptionalString(request.body, "repositoryId");
  const worktreeId = readOptionalString(request.body, "worktreeId");

  try {
    const state = await localStore.update((store) => {
      store.selection = resolveRequestedSelection(store, repositoryId, worktreeId);
      return buildAppStateResource(store);
    });

    broadcast({ type: "state.changed", reason: "selection.update" });
    response.json(state);
  } catch (error) {
    next(error);
  }
});

app.get("/api/repositories", async (request, response, next) => {
  try {
    const store = await localStore.read();
    response.json({ repositories: buildRepositoryResources(store, readResourceOptions(request)) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/repositories", async (request, response, next) => {
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

app.get("/api/repositories/:repositoryId", async (request, response, next) => {
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

app.get("/api/repositories/:repositoryId/worktrees", async (request, response, next) => {
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

app.get("/api/worktrees", async (request, response, next) => {
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

app.get("/api/repository-settings", async (request, response, next) => {
  try {
    const store = await localStore.read();
    const repositories = buildRepositoryResources(store, readResourceOptions(request));

    response.json({ repositorySettings: repositories.map((repository) => repository.settings) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/repositories/:repositoryId/settings", async (request, response, next) => {
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

    response.json({ settings: buildRepositoryResource(store, repository, options).settings });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/repositories/:repositoryId/settings", async (request, response, next) => {
  const repositoryId = readRouteParam(request, "repositoryId");

  try {
    const store = await localStore.read();
    const repository = findVisibleRepository(store, repositoryId);
    const nextSettings = await readRepositorySettingsBody(request.body, repositoryId, repository.primaryWorktreePath);

    const state = await runExclusiveMutation("repository-settings.update", async () =>
      localStore.update((mutableStore) => {
        const timestamp = nowIso();
        const settingsIndex = mutableStore.repositorySettings.findIndex((record) => record.repositoryId === repositoryId);
        const previousSettings = settingsIndex >= 0 ? mutableStore.repositorySettings[settingsIndex] : undefined;
        const settings: RepositorySettingsRecord = {
          repositoryId,
          setup: nextSettings.setup,
          createdAt: previousSettings?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        const mutableRepository = findVisibleRepository(mutableStore, repositoryId);

        if (settingsIndex >= 0) {
          mutableStore.repositorySettings[settingsIndex] = settings;
        } else {
          mutableStore.repositorySettings.push(settings);
        }

        mutableRepository.updatedAt = timestamp;
        appendOperationRecord(mutableStore, {
          type: "repository-settings.update",
          status: "success",
          severity: "success",
          summary: "Repository Settings saved",
          repositoryId,
          details: compactJsonObject({
            setupEnabled: settings.setup.enabled,
            autoStartDevServer: settings.setup.autoStartDevServer,
          }),
        });

        return buildAppStateResource(mutableStore);
      }),
    );

    broadcast({ type: "state.changed", reason: "repository-settings.update" });
    response.json(state);
  } catch (error) {
    await recordOperationSafely({
      type: "repository-settings.update",
      status: "failed",
      severity: "error",
      summary: "Repository Settings save failed",
      repositoryId,
      details: compactJsonObject({
        error: toApiError(error).message,
      }),
    });
    next(error);
  }
});

app.post("/api/repositories/:repositoryId/worktrees/existing", async (request, response, next) => {
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

app.get("/api/repositories/:repositoryId/new-worktree-context", async (request, response, next) => {
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

app.post("/api/repositories/:repositoryId/worktrees", async (request, response, next) => {
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

app.get("/api/tracked-processes", async (request, response, next) => {
  try {
    const store = await localStore.read();
    const options = readResourceOptions(request);
    const repositoryId = readOptionalQueryString(request, "repositoryId");
    const worktreeId = readOptionalQueryString(request, "worktreeId");
    const visibleWorktreeIds = new Set(buildWorktreeResources(store, options).map((worktree) => worktree.worktreeId));
    const trackedProcesses = store.trackedProcesses.filter(
      (processRecord) =>
        visibleWorktreeIds.has(processRecord.worktreeId) &&
        (!repositoryId || processRecord.repositoryId === repositoryId) &&
        (!worktreeId || processRecord.worktreeId === worktreeId),
    );

    response.json({ trackedProcesses });
  } catch (error) {
    next(error);
  }
});

app.get("/api/operations", async (_request, response, next) => {
  try {
    const store = await localStore.read();
    response.json({ operations: [...store.operations].reverse() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/repositories/inspect", async (request, response, next) => {
  const requestedRepositoryPath = readOptionalString(request.body, "repositoryPath");

  try {
    response.json(await inspectRepository(readRequiredString(request.body, "repositoryPath")));
  } catch (error) {
    await recordOperationSafely({
      type: "repository.inspect",
      status: "failed",
      severity: "error",
      summary: "Repository inspection failed",
      details: compactJsonObject({
        repositoryPath: requestedRepositoryPath,
        error: toApiError(error).message,
      }),
    });
    next(error);
  }
});

app.post("/api/worktrees", async (request, response, next) => {
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

app.post("/api/worktrees/remove", async (request, response, next) => {
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

app.use(express.static(webDist));

app.get(/.*/, (request, response, next) => {
  if (request.path.startsWith("/api/")) {
    next();
    return;
  }

  response.sendFile(path.join(webDist, "index.html"), (error) => {
    if (error) {
      next(error);
    }
  });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const apiError = toApiError(error);
  response.status(apiError.statusCode).json({ error: apiError.message });
});

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  sockets.handleUpgrade(request, socket, head, (websocket) => {
    sockets.emit("connection", websocket, request);
  });
});

sockets.on("connection", (websocket) => {
  sendJson(websocket, {
    type: "server.ready",
    host,
    port,
    remoteEnabled: host === "0.0.0.0",
  });
});

server.listen(port, host, () => {
  const urls = getAdvertisedUrls(host, port).join(", ");
  console.log(`RepoBinder backend listening on ${host}:${port}`);
  console.log(`Open ${urls}`);
});

process.on("SIGTERM", () => {
  shutdown();
});

process.on("SIGINT", () => {
  shutdown();
});

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const parsedPort = Number(rawPort);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }

  return parsedPort;
}

function readRequiredString(body: unknown, field: string): string {
  const value = readOptionalString(body, field);

  if (!value) {
    throw new ApiError(400, `Missing ${field}`);
  }

  return value;
}

function readOptionalString(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  const value = body[field];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRouteParam(request: Request, field: string): string {
  const value = request.params[field];

  if (typeof value !== "string" || !value) {
    throw new ApiError(400, `Missing route parameter ${field}`);
  }

  return value;
}

function readOptionalQueryString(request: Request, field: string): string | undefined {
  const value = request.query[field];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readResourceOptions(request: Request): { includeDeleted: boolean } {
  const includeDeleted = request.query.includeDeleted;

  return {
    includeDeleted: includeDeleted === "true" || includeDeleted === "1",
  };
}

function compactJsonObject(input: Record<string, JsonValue | undefined>): JsonObject {
  const output: JsonObject = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

async function recordOperationSafely(input: CreateOperationInput): Promise<void> {
  try {
    await localStore.recordOperation(input);
    broadcast({ type: "operations.changed" });
  } catch (error) {
    console.error("Failed to record Operation Record", error);
  }
}

async function runExclusiveMutation<T>(_operationType: string, operation: () => Promise<T>): Promise<T> {
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

function requireDesktopAuth(request: Request): void {
  const desktopToken = process.env.REPOBINDER_DESKTOP_TOKEN;

  if (!desktopToken) {
    throw new ApiError(403, "Desktop bridge is required for this action");
  }

  if (request.header("x-repobinder-desktop-token") !== desktopToken) {
    throw new ApiError(403, "Desktop authorization failed");
  }
}

function findVisibleRepository(store: RepoBinderStore, repositoryId: string) {
  const repository = store.repositories.find((record) => record.repositoryId === repositoryId && !record.deletedAt);

  if (!repository) {
    throw new ApiError(404, `Repository Record not found: ${repositoryId}`);
  }

  return repository;
}

function resolveRequestedSelection(
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

async function readRepositorySettingsBody(
  body: unknown,
  repositoryId: string,
  primaryWorktreePath: string,
): Promise<RepositorySettingsRecord> {
  if (!isRecord(body) || !isRecord(body.setup)) {
    throw new ApiError(400, "Missing setup settings");
  }

  const timestamp = nowIso();
  const enabled = Boolean(body.setup.enabled);
  const command = readOptionalString(body.setup, "command");
  const defaultArgs = body.setup.defaultArgs === undefined ? [] : readStringArray(body.setup.defaultArgs, "defaultArgs");
  const autoStartDevServer = enabled && Boolean(body.setup.autoStartDevServer);

  if (enabled && !command) {
    throw new ApiError(400, "Setup command is required when setup is enabled");
  }

  if (enabled && command) {
    await validateSetupCommand(command, primaryWorktreePath);
  }

  if (autoStartDevServer && containsPortArg(defaultArgs)) {
    throw new ApiError(400, "Default setup args cannot include --port when Auto Start Dev Server is enabled");
  }

  return {
    repositoryId,
    setup: {
      enabled,
      command,
      defaultArgs,
      autoStartDevServer,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(400, `${field} must be an array`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new ApiError(400, `${field}[${index}] must be a string`);
    }

    if (/[\0\r\n]/.test(entry)) {
      throw new ApiError(400, `${field}[${index}] contains unsupported control characters`);
    }

    return entry;
  });
}

async function validateSetupCommand(command: string, primaryWorktreePath: string): Promise<void> {
  if (/[\0\r\n]/.test(command)) {
    throw new ApiError(400, "Setup command contains unsupported control characters");
  }

  if (command === "." || command === ".." || command.startsWith("~")) {
    throw new ApiError(400, "Setup command must be an executable name or a path inside the Primary Worktree");
  }

  if (!isPathLikeCommand(command)) {
    return;
  }

  const resolvedCommandPath = path.isAbsolute(command) ? path.resolve(command) : path.resolve(primaryWorktreePath, command);
  const relativeCommandPath = path.relative(primaryWorktreePath, resolvedCommandPath);

  if (relativeCommandPath.startsWith("..") || path.isAbsolute(relativeCommandPath)) {
    throw new ApiError(400, "Setup command paths must stay inside the Primary Worktree");
  }

  try {
    await fs.access(resolvedCommandPath);
  } catch {
    throw new ApiError(400, `Setup command path does not exist: ${resolvedCommandPath}`);
  }
}

function isPathLikeCommand(command: string): boolean {
  return path.isAbsolute(command) || command.startsWith(".") || command.includes("/") || command.includes("\\");
}

function containsPortArg(args: string[]): boolean {
  return args.some((arg) => arg === "--port" || arg.startsWith("--port="));
}

function createWorktreeRecord(input: {
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
      warnings: [],
    },
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
}

function readNewWorktreeRows(body: unknown): (string | undefined)[] {
  if (!isRecord(body) || !Array.isArray(body.rows)) {
    throw new ApiError(400, "New Worktree requires a rows array");
  }

  if (body.rows.length < 1 || body.rows.length > 5) {
    throw new ApiError(400, "New Worktree accepts 1 to 5 rows");
  }

  const names = body.rows.map((row) => {
    if (!isRecord(row) || typeof row.branchName !== "string") {
      return undefined;
    }

    const trimmed = row.branchName.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

  if (!names[0]) {
    throw new ApiError(400, "The first Branch name is required");
  }

  return names;
}

function resolveBatchRows(names: (string | undefined)[], primaryWorktreePath: string): BatchRow[] {
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

async function validateBatchRows(
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

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
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

function buildAddWorktreeArgs(
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

async function inspectRepository(inputPath: string): Promise<RepositoryInspection> {
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

async function assertPrimaryWorktreeInput(inputPath: string, inspection: RepositoryInspection): Promise<void> {
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

async function assertExistingLinkedWorktreeInput(
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

async function runGit(repositoryPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", ["-C", repositoryPath, ...args], {
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    if (isExecError(error)) {
      const details = error.stderr?.trim() || error.stdout?.trim() || error.message;
      throw new ApiError(400, details);
    }

    throw error;
  }
}

function parseWorktreePorcelain(output: string): Worktree[] {
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

async function addRealPaths(worktrees: Worktree[]): Promise<Worktree[]> {
  return Promise.all(
    worktrees.map(async (worktree) => ({
      ...worktree,
      realPath: await fs.realpath(worktree.path).catch(() => undefined),
    })),
  );
}

function findInspectedWorktree(inspection: RepositoryInspection, realWorktreePath: string): Worktree | undefined {
  return inspection.worktrees.find((worktree) => worktree.realPath === realWorktreePath);
}

function resolveGitPath(repositoryPath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? path.resolve(gitPath) : path.resolve(repositoryPath, gitPath);
}

function getAdvertisedUrls(bindHost: string, bindPort: number): string[] {
  const urls = new Set<string>([`http://127.0.0.1:${bindPort}`]);

  if (bindHost !== "0.0.0.0") {
    return [...urls];
  }

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.add(`http://${address.address}:${bindPort}`);
      }
    }
  }

  return [...urls];
}

function broadcast(message: SocketMessage): void {
  for (const socket of sockets.clients) {
    sendJson(socket, message);
  }
}

function sendJson(socket: WebSocket, message: SocketMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function shutdown(): void {
  sockets.close();
  server.close(() => {
    process.exit(0);
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Error) {
    return new ApiError(500, error.message);
  }

  return new ApiError(500, "Unknown server error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isExecError(value: unknown): value is Error & { stdout?: string; stderr?: string } {
  return value instanceof Error;
}
