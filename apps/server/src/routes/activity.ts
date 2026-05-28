import { Router } from "express";

import { buildWorktreeResources } from "../resources";
import { localStore } from "../context";
import { readOptionalQueryString, readResourceOptions } from "../lib/request";

export const activityRouter = Router();

activityRouter.get("/api/tracked-processes", async (request, response, next) => {
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

activityRouter.get("/api/operations", async (_request, response, next) => {
  try {
    const store = await localStore.read();
    response.json({ operations: [...store.operations].reverse() });
  } catch (error) {
    next(error);
  }
});
