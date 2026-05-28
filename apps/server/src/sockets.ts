import http from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { host, port } from "./config";
import { SocketMessage } from "./lib/types";

export const sockets = new WebSocketServer({ noServer: true });

export function broadcast(message: SocketMessage): void {
  for (const socket of sockets.clients) {
    sendJson(socket, message);
  }
}

function sendJson(socket: WebSocket, message: SocketMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export function attachSockets(server: http.Server): void {
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
}
