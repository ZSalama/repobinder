import { Router } from "express";

import { buildAppStateResource } from "../resources";
import { localStore, resolveRequestedSelection } from "../context";
import { readOptionalString, readResourceOptions } from "../lib/request";
import { broadcast } from "../sockets";

export const stateRouter = Router();

stateRouter.get("/api/state", async (request, response, next) => {
  try {
    const store = await localStore.read();
    response.json(buildAppStateResource(store, readResourceOptions(request)));
  } catch (error) {
    next(error);
  }
});

stateRouter.patch("/api/selection", async (request, response, next) => {
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
