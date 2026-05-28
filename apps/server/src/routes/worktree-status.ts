import fs from "node:fs/promises";
import path from "node:path";

import { Router } from "express";

import { buildAppStateResource } from "../resources";
import { findVisibleRepository, localStore, recordOperationSafely } from "../context";
import { ApiError, toApiError } from "../lib/errors";
import { compactJsonObject, nowIso } from "../lib/json";
import { readRouteParam } from "../lib/request";
import { inspectRepository } from "../git/inspection";
import { Worktree } from "../lib/types";
import { probeDevServerStatus, probeProcessStatus } from "../setup/devserver";
import { isLocalhostUrl, isPortReachable, parseUrlHost, parseUrlPort } from "../setup/status";
import { DevServerStatus, TrackedProcessStatus, WorktreeRecord } from "../store";

export const worktreeStatusRouter = Router();

// Manual/startup/focus refresh for tracked Worktree Git state. This only
// updates records RepoBinder already knows about; it does not discover or add
// unmanaged Git worktrees.
worktreeStatusRouter.post("/api/repositories/:repositoryId/refresh", async (request, response, next) => {
  const repositoryId = readRouteParam(request, "repositoryId");

  try {
    const store = await localStore.read();
    const repository = findVisibleRepository(store, repositoryId);
    const inspection = await inspectRepository(repository.primaryWorktreePath);
    const existingPathByWorktreeId = new Map<string, boolean>();

    await Promise.all(
      store.worktrees
        .filter((worktree) => worktree.repositoryId === repositoryId && !worktree.deletedAt)
        .map(async (worktree) => {
          existingPathByWorktreeId.set(worktree.worktreeId, await pathExists(worktree.worktreePath));
        }),
    );

    const state = await localStore.update((mutableStore) => {
      const timestamp = nowIso();
      const mutableRepository = findVisibleRepository(mutableStore, repositoryId);

      for (const worktree of mutableStore.worktrees) {
        if (worktree.repositoryId !== repositoryId || worktree.deletedAt) {
          continue;
        }

        const inspectedWorktree = findMatchingInspectedWorktree(worktree, inspection.worktrees);

        if (inspectedWorktree) {
          worktree.branch = inspectedWorktree.branch;
          worktree.head = inspectedWorktree.head;
          worktree.availability = inspectedWorktree.realPath ? "available" : "missing";
          worktree.locked = inspectedWorktree.locked;
          worktree.prunable = inspectedWorktree.prunable;
          worktree.updatedAt = timestamp;
          continue;
        }

        worktree.availability = existingPathByWorktreeId.get(worktree.worktreeId) ? "unknown" : "missing";
        worktree.locked = undefined;
        worktree.prunable = undefined;
        worktree.updatedAt = timestamp;
      }

      mutableRepository.updatedAt = timestamp;
      return buildAppStateResource(mutableStore);
    });

    response.json(state);
  } catch (error) {
    await recordOperationSafely({
      type: "repository.refresh",
      status: "failed",
      severity: "warning",
      summary: "Repository refresh failed",
      repositoryId,
      details: compactJsonObject({
        error: toApiError(error).message,
      }),
    });
    next(error);
  }
});

// Light status refresh for the Selected Repository. Re-probes tracked process
// liveness and Dev Server reachability and persists the result. This is not a
// global mutating operation and does not broadcast, so callers can poll it.
worktreeStatusRouter.post("/api/repositories/:repositoryId/worktree-status", async (request, response, next) => {
  try {
    const repositoryId = readRouteParam(request, "repositoryId");
    const store = await localStore.read();
    findVisibleRepository(store, repositoryId);

    const processStatuses = new Map<string, TrackedProcessStatus>();

    for (const processRecord of store.trackedProcesses) {
      if (processRecord.repositoryId === repositoryId) {
        processStatuses.set(processRecord.processRecordId, probeProcessStatus(processRecord.pid));
      }
    }

    const devServerStatuses = new Map<string, DevServerStatus>();

    for (const worktree of store.worktrees) {
      if (worktree.repositoryId === repositoryId && !worktree.deletedAt && worktree.devServer) {
        devServerStatuses.set(worktree.worktreeId, await probeDevServerStatus(worktree.devServer));
      }
    }

    const state = await localStore.update((mutableStore) => {
      const timestamp = nowIso();

      for (const processRecord of mutableStore.trackedProcesses) {
        const status = processStatuses.get(processRecord.processRecordId);

        if (!status) {
          continue;
        }

        processRecord.status = status;
        processRecord.updatedAt = timestamp;

        if (status === "running") {
          processRecord.lastSeenAt = timestamp;
        } else if (status === "stopped" && !processRecord.stoppedAt) {
          processRecord.stoppedAt = timestamp;
        }
      }

      for (const worktree of mutableStore.worktrees) {
        const status = devServerStatuses.get(worktree.worktreeId);

        if (worktree.devServer && status) {
          worktree.devServer = { ...worktree.devServer, status, updatedAt: timestamp };
        }
      }

      return buildAppStateResource(mutableStore);
    });

    response.json(state);
  } catch (error) {
    next(error);
  }
});

// Open Dev verifies host-side reachability before the client opens the URL.
// Only localhost URLs are actionable. Failures create a warning Operation
// Record; successes do not.
worktreeStatusRouter.post(
  "/api/repositories/:repositoryId/worktrees/:worktreeId/open-dev",
  async (request, response, next) => {
    const repositoryId = readRouteParam(request, "repositoryId");
    const worktreeId = readRouteParam(request, "worktreeId");

    try {
      const store = await localStore.read();
      findVisibleRepository(store, repositoryId);
      const worktree = store.worktrees.find(
        (record) => record.worktreeId === worktreeId && record.repositoryId === repositoryId && !record.deletedAt,
      );

      if (!worktree) {
        throw new ApiError(404, `Worktree Record not found: ${worktreeId}`);
      }

      const url = resolveDevServerUrl(worktree.devServer);

      if (!url) {
        throw new ApiError(400, "No localhost Dev Server URL is known for this Worktree");
      }

      const host = parseUrlHost(url) ?? "127.0.0.1";
      const port = parseUrlPort(url);

      if (port === undefined) {
        throw new ApiError(400, "Dev Server URL does not include a port to verify");
      }

      const reachable = await isPortReachable(host, port);

      if (!reachable) {
        await recordOperationSafely({
          type: "worktree.open-dev",
          status: "warning",
          severity: "warning",
          summary: "Dev Server is not reachable",
          repositoryId,
          worktreeId,
          details: compactJsonObject({ url }),
        });
      }

      response.json({ url, reachable });
    } catch (error) {
      await recordOperationSafely({
        type: "worktree.open-dev",
        status: "failed",
        severity: "warning",
        summary: "Open Dev failed",
        repositoryId,
        worktreeId,
        details: compactJsonObject({ error: toApiError(error).message }),
      });

      next(error);
    }
  },
);

function resolveDevServerUrl(devServer: { url?: string; port?: number } | undefined): string | undefined {
  if (!devServer) {
    return undefined;
  }

  if (devServer.url) {
    return isLocalhostUrl(devServer.url) ? devServer.url : undefined;
  }

  if (devServer.port !== undefined) {
    return `http://127.0.0.1:${devServer.port}`;
  }

  return undefined;
}

function findMatchingInspectedWorktree(record: WorktreeRecord, inspectedWorktrees: Worktree[]): Worktree | undefined {
  const recordedPath = path.resolve(record.worktreePath);
  const recordedRealPath = path.resolve(record.realWorktreePath);

  return inspectedWorktrees.find((worktree) => {
    if (worktree.realPath && path.resolve(worktree.realPath) === recordedRealPath) {
      return true;
    }

    const inspectedPath = path.resolve(worktree.path);
    return inspectedPath === recordedPath || inspectedPath === recordedRealPath;
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
