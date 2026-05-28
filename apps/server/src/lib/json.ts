import { JsonObject, JsonValue } from "../store";

export function compactJsonObject(input: Record<string, JsonValue | undefined>): JsonObject {
  const output: JsonObject = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

export function nowIso(): string {
  return new Date().toISOString();
}
