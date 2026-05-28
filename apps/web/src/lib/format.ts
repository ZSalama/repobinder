import { DevServerStatus, RepositorySettings, SettingsDraft, SetupStatus, WorktreeResource } from "@/types";

export function createSettingsDraft(settings: RepositorySettings): SettingsDraft {
  return {
    setupEnabled: settings.setup.enabled,
    command: settings.setup.command ?? "",
    defaultArgsText: settings.setup.defaultArgs.join("\n"),
    autoStartDevServer: settings.setup.autoStartDevServer,
  };
}

export function parseArgsText(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatSetupStatus(status: SetupStatus): string {
  switch (status) {
    case "not_configured":
      return "Not Configured";
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "warning":
      return "Warning";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
  }
}

export function setupTone(status: SetupStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "failed":
      return "danger";
    case "running":
    case "pending":
      return "info";
    case "not_configured":
    case "skipped":
      return "neutral";
  }
}

export function formatDevServer(devServer: WorktreeResource["devServer"]): string {
  if (!devServer) {
    return "Unknown";
  }

  if (devServer.url) {
    return devServer.url;
  }

  if (devServer.port) {
    return `:${devServer.port}`;
  }

  return devServer.status;
}

export function devServerTone(
  status: DevServerStatus | undefined,
): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "running":
      return "success";
    case "unreachable":
      return "warning";
    case "stopped":
      return "neutral";
    case "unknown":
    case undefined:
      return "neutral";
  }
}
