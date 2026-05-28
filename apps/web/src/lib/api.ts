import { DesktopContext } from "@/types";

export async function api<T>(
  pathName: string,
  init: RequestInit = {},
  desktopContext?: DesktopContext,
): Promise<T> {
  const response = await fetch(pathName, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(desktopContext?.desktopAuthToken
        ? {
            "X-RepoBinder-Desktop-Token": desktopContext.desktopAuthToken,
          }
        : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(typeof body?.error === "string" ? body.error : response.statusText);
  }

  return response.json() as Promise<T>;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error";
}

export function safeParseSocketMessage(data: unknown): { type?: string } | undefined {
  if (typeof data !== "string") {
    return undefined;
  }

  try {
    const value = JSON.parse(data) as unknown;

    if (typeof value === "object" && value !== null) {
      return value as { type?: string };
    }
  } catch {
    return undefined;
  }

  return undefined;
}
