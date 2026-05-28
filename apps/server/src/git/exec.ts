import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MAX_GIT_OUTPUT_BYTES } from "../config";
import { ApiError } from "../lib/errors";

export const execFileAsync = promisify(execFile);

export async function runGit(repositoryPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", ["-C", repositoryPath, ...args], {
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    if (isExecError(error)) {
      const details = error.stderr?.trim() || error.stdout?.trim() || error.message;
      throw new ApiError(400, details);
    }

    throw error;
  }
}

function isExecError(value: unknown): value is Error & { stdout?: string; stderr?: string } {
  return value instanceof Error;
}
