import http from "node:http";
import path from "node:path";

import express, { NextFunction, Request, Response } from "express";

import { getAdvertisedUrls, host, port, webDist } from "./config";
import { toApiError } from "./lib/errors";
import { activityRouter } from "./routes/activity";
import { linkedWorktreesRouter } from "./routes/linked-worktrees";
import { repositoriesRouter } from "./routes/repositories";
import { serverInfoRouter } from "./routes/server-info";
import { settingsRouter } from "./routes/settings";
import { stateRouter } from "./routes/state";
import { worktreeStatusRouter } from "./routes/worktree-status";
import { attachSockets, sockets } from "./sockets";

const app = express();
const server = http.createServer(app);

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use(serverInfoRouter);
app.use(stateRouter);
app.use(repositoriesRouter);
app.use(settingsRouter);
app.use(linkedWorktreesRouter);
app.use(worktreeStatusRouter);
app.use(activityRouter);

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

attachSockets(server);

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

function shutdown(): void {
  sockets.close();
  server.close(() => {
    process.exit(0);
  });
}
