import { Router } from "express";

import { buildAppStateResource } from "../resources";
import { findVisibleRepository, localStore, recordOperationSafely } from "../context";
import { ApiError, toApiError } from "../lib/errors";
import { compactJsonObject, nowIso } from "../lib/json";
import { readRouteParam } from "../lib/request";
import { probeDevServerStatus, probeProcessStatus } from "../setup/devserver";
import { isLocalhostUrl, isPortReachable, parseUrlHost, parseUrlPort } from "../setup/status";
import { DevServerStatus, TrackedProcessStatus } from "../store";

export const worktreeStatusRouter = Router();

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
      if (!(error instanceof ApiError && (error.statusCode === 400 || error.statusCode === 404))) {
        await recordOperationSafely({
          type: "worktree.open-dev",
          status: "failed",
          severity: "warning",
          summary: "Open Dev failed",
          repositoryId,
          worktreeId,
          details: compactJsonObject({ error: toApiError(error).message }),
        });
      }

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
