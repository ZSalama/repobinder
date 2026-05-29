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
import { createDefaultRepositorySettings, DevServerStatus, TrackedProcessStatus, WorktreeRecord } from "../store";

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
// Localhost URLs and known ports are actionable. With Tailscale Routing enabled,
// the response URL can use the requesting browser's host while reachability is
// still checked from the RepoBinder host.
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

      const settings =
        store.repositorySettings.find((record) => record.repositoryId === repositoryId) ??
        createDefaultRepositorySettings(repositoryId);
      const tailscaleRouting = settings.setup.enabled && settings.setup.autoStartDevServer && settings.setup.tailscaleRouting;
      const devServerUrl = resolveDevServerUrl(worktree.devServer, {
        requestHost: request.headers.host,
        requestProtocol: request.protocol,
        tailscaleRouting,
      });

      if (!devServerUrl) {
        throw new ApiError(400, "No actionable Dev Server URL is known for this Worktree");
      }

      const reachable = await isPortReachable(devServerUrl.reachabilityHost, devServerUrl.reachabilityPort);

      if (!reachable) {
        await recordOperationSafely({
          type: "worktree.open-dev",
          status: "warning",
          severity: "warning",
          summary: "Dev Server is not reachable",
          repositoryId,
          worktreeId,
          details: compactJsonObject({ url: devServerUrl.url }),
        });
      }

      response.json({ url: devServerUrl.url, reachable });
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

type DevServerUrlResolution = {
  url: string;
  reachabilityHost: string;
  reachabilityPort: number;
};

function resolveDevServerUrl(
  devServer: { url?: string; port?: number } | undefined,
  options: { requestHost?: string; requestProtocol: string; tailscaleRouting: boolean },
): DevServerUrlResolution | undefined {
  if (!devServer) {
    return undefined;
  }

  const port = devServer.port ?? (devServer.url ? parseUrlPort(devServer.url) : undefined);

  if (port === undefined) {
    return undefined;
  }

  const reachabilityHost = devServer.url ? parseUrlHost(devServer.url) ?? "127.0.0.1" : "127.0.0.1";
  const remoteUrl = options.tailscaleRouting
    ? buildRemoteDevServerUrl(options.requestHost, options.requestProtocol, port)
    : undefined;

  if (remoteUrl) {
    return { url: remoteUrl, reachabilityHost, reachabilityPort: port };
  }

  if (devServer.url && isLocalhostUrl(devServer.url)) {
    return { url: devServer.url, reachabilityHost, reachabilityPort: port };
  }

  if (devServer.port !== undefined) {
    return { url: `http://127.0.0.1:${port}`, reachabilityHost: "127.0.0.1", reachabilityPort: port };
  }

  return undefined;
}

function buildRemoteDevServerUrl(requestHost: string | undefined, requestProtocol: string, port: number): string | undefined {
  const hostname = parseRequestHostname(requestHost);

  if (!hostname || isLoopbackHostname(hostname)) {
    return undefined;
  }

  return `${requestProtocol}://${formatUrlHostname(hostname)}:${port}`;
}

function parseRequestHostname(requestHost: string | undefined): string | undefined {
  if (!requestHost) {
    return undefined;
  }

  try {
    return new URL(`http://${requestHost}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function formatUrlHostname(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
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
