import { Router } from "express";

import { buildAppStateResource, buildRepositoryResource, buildRepositoryResources } from "../resources";
import { findVisibleRepository, localStore, recordOperationSafely, runExclusiveMutation } from "../context";
import { ApiError, toApiError } from "../lib/errors";
import { compactJsonObject, nowIso } from "../lib/json";
import { readRepositorySettingsBody, readResourceOptions, readRouteParam } from "../lib/request";
import { broadcast } from "../sockets";
import { appendOperationRecord, RepositorySettingsRecord } from "../store";

export const settingsRouter = Router();

settingsRouter.get("/api/repository-settings", async (request, response, next) => {
  try {
    const store = await localStore.read();
    const repositories = buildRepositoryResources(store, readResourceOptions(request));

    response.json({ repositorySettings: repositories.map((repository) => repository.settings) });
  } catch (error) {
    next(error);
  }
});

settingsRouter.get("/api/repositories/:repositoryId/settings", async (request, response, next) => {
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

settingsRouter.patch("/api/repositories/:repositoryId/settings", async (request, response, next) => {
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
            tailscaleRouting: settings.setup.tailscaleRouting,
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
