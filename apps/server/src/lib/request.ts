import fs from "node:fs/promises";
import path from "node:path";

import { Request } from "express";

import { RepositorySettingsRecord } from "../store";
import { ApiError } from "./errors";
import { nowIso } from "./json";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readRequiredString(body: unknown, field: string): string {
  const value = readOptionalString(body, field);

  if (!value) {
    throw new ApiError(400, `Missing ${field}`);
  }

  return value;
}

export function readOptionalString(body: unknown, field: string): string | undefined {
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

export function readRouteParam(request: Request, field: string): string {
  const value = request.params[field];

  if (typeof value !== "string" || !value) {
    throw new ApiError(400, `Missing route parameter ${field}`);
  }

  return value;
}

export function readOptionalQueryString(request: Request, field: string): string | undefined {
  const value = request.query[field];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readResourceOptions(request: Request): { includeDeleted: boolean } {
  const includeDeleted = request.query.includeDeleted;

  return {
    includeDeleted: includeDeleted === "true" || includeDeleted === "1",
  };
}

export function requireDesktopAuth(request: Request): void {
  const desktopToken = process.env.REPOBINDER_DESKTOP_TOKEN;

  if (!desktopToken) {
    throw new ApiError(403, "Desktop bridge is required for this action");
  }

  if (request.header("x-repobinder-desktop-token") !== desktopToken) {
    throw new ApiError(403, "Desktop authorization failed");
  }
}

export function readStringArray(value: unknown, field: string): string[] {
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

export type NewWorktreeRequest = {
  names: (string | undefined)[];
  rowArgs: string[][];
  sharedArgs: string[];
};

export function readNewWorktreeRequest(body: unknown): NewWorktreeRequest {
  if (!isRecord(body) || !Array.isArray(body.rows)) {
    throw new ApiError(400, "New Worktree requires a rows array");
  }

  if (body.rows.length < 1 || body.rows.length > 5) {
    throw new ApiError(400, "New Worktree accepts 1 to 5 rows");
  }

  const names: (string | undefined)[] = [];
  const rowArgs: string[][] = [];

  body.rows.forEach((row, index) => {
    const branchName = isRecord(row) && typeof row.branchName === "string" ? row.branchName.trim() : "";
    names.push(branchName.length > 0 ? branchName : undefined);
    rowArgs.push(isRecord(row) && row.args !== undefined ? readStringArray(row.args, `rows[${index}].args`) : []);
  });

  if (!names[0]) {
    throw new ApiError(400, "The first Branch name is required");
  }

  const sharedArgs = isRecord(body) && body.sharedArgs !== undefined ? readStringArray(body.sharedArgs, "sharedArgs") : [];

  return { names, rowArgs, sharedArgs };
}

export function argsContainPort(args: string[]): boolean {
  return args.some((arg) => arg === "--port" || arg.startsWith("--port="));
}

export async function readRepositorySettingsBody(
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

  if (autoStartDevServer && argsContainPort(defaultArgs)) {
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

