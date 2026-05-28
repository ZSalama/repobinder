import { Router } from "express";

import { getAdvertisedUrls, host, port } from "../config";
import { localStore } from "../context";
import { OPERATION_RETENTION_LIMIT } from "../store";

export const serverInfoRouter = Router();

serverInfoRouter.get("/health", (_request, response) => {
  response.type("text/plain").send("ok");
});

serverInfoRouter.get("/api/server", (_request, response) => {
  response.json({
    name: "repobinder",
    host,
    port,
    remoteEnabled: host === "0.0.0.0",
    advertisedUrls: getAdvertisedUrls(host, port),
  });
});

serverInfoRouter.get("/api/store/meta", async (_request, response, next) => {
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
