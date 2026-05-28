import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Menu,
  Plus,
  RefreshCw,
  Server,
  Settings,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type WorktreeType = "primary" | "linked";
type SetupStatus = "not_configured" | "pending" | "running" | "success" | "warning" | "failed" | "skipped";
type DevServerStatus = "unknown" | "running" | "stopped" | "unreachable";
type SocketState = "connecting" | "open" | "closed";

type RepositorySettings = {
  repositoryId: string;
  setup: {
    enabled: boolean;
    command?: string;
    defaultArgs: string[];
    autoStartDevServer: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

type WorktreeResource = {
  worktreeId: string;
  repositoryId: string;
  type: WorktreeType;
  worktreePath: string;
  realWorktreePath: string;
  gitCommonDir: string;
  branch?: string;
  head?: string;
  availability: "available" | "missing" | "unknown";
  locked?: string;
  prunable?: string;
  createdByRepoBinder: boolean;
  setup: {
    status: SetupStatus;
    updatedAt?: string;
    warnings: string[];
    lastExitCode?: number;
  };
  devServer?: {
    status: DevServerStatus;
    url?: string;
    port?: number;
    pid?: number;
    updatedAt?: string;
  };
  trackedProcesses: unknown[];
  createdAt: string;
  updatedAt: string;
};

type RepositoryResource = {
  repositoryId: string;
  displayName: string;
  primaryWorktreeId: string;
  primaryWorktreePath: string;
  realPrimaryWorktreePath: string;
  gitCommonDir: string;
  settings: RepositorySettings;
  primaryWorktree?: WorktreeResource;
  worktrees: WorktreeResource[];
  createdAt: string;
  updatedAt: string;
};

type AppStateResource = {
  schemaVersion: number;
  selection: {
    repositoryId?: string;
    worktreeId?: string;
    updatedAt?: string;
  };
  repositories: RepositoryResource[];
  operations: unknown[];
};

type NewWorktreeContext = {
  repositoryId: string;
  primaryWorktreePath: string;
  baseBranch?: string;
  detached: boolean;
  dirty: boolean;
};

type BatchRowResult = {
  index: number;
  branchName: string;
  worktreePath: string;
  status: "created" | "failed";
  error?: string;
};

type BatchResult = {
  baseBranch: string;
  dirty: boolean;
  created: number;
  failed: number;
  warnings: string[];
  rows: BatchRowResult[];
};

type BatchResponse = {
  state: AppStateResource;
  result: BatchResult;
};

type BatchValidationRow = {
  index: number;
  branchName: string;
  worktreePath: string;
  errors: string[];
};

type ServerInfo = {
  name: string;
  host: string;
  port: number;
  remoteEnabled: boolean;
  advertisedUrls: string[];
};

type DesktopContext = {
  platform: string;
  desktopAuthToken: string;
};

type SettingsDraft = {
  setupEnabled: boolean;
  command: string;
  defaultArgsText: string;
  autoStartDevServer: boolean;
};

type Banner = {
  tone: "success" | "warning" | "danger" | "info";
  text: string;
};

declare global {
  interface Window {
    repobinderDesktop?: {
      getDesktopContext: () => Promise<DesktopContext>;
      pickRepositoryFolder: () => Promise<string | undefined>;
    };
  }
}

export function App(): JSX.Element {
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>();
  const [desktopContext, setDesktopContext] = useState<DesktopContext | undefined>();
  const [appState, setAppState] = useState<AppStateResource | undefined>();
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [loadFailure, setLoadFailure] = useState<string | undefined>();
  const [busyAction, setBusyAction] = useState<string | undefined>();
  const [banner, setBanner] = useState<Banner | undefined>();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | undefined>();
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [newWorktreeContext, setNewWorktreeContext] = useState<NewWorktreeContext | undefined>();
  const [newWorktreeLoading, setNewWorktreeLoading] = useState(false);
  const [newWorktreeRows, setNewWorktreeRows] = useState<string[]>([""]);
  const [newWorktreeRowErrors, setNewWorktreeRowErrors] = useState<Record<number, string[]>>({});

  const selectedRepository = useMemo(() => {
    if (!appState) {
      return undefined;
    }

    return (
      appState.repositories.find((repository) => repository.repositoryId === appState.selection.repositoryId) ??
      appState.repositories[0]
    );
  }, [appState]);

  const selectedWorktreeId = appState?.selection.worktreeId ?? selectedRepository?.primaryWorktreeId;
  const selectedWorktree = selectedRepository?.worktrees.find((worktree) => worktree.worktreeId === selectedWorktreeId);
  const isDesktop = Boolean(window.repobinderDesktop && desktopContext?.desktopAuthToken);
  const isBusy = Boolean(busyAction);

  useEffect(() => {
    document.documentElement.classList.add("dark");

    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, []);

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    setSocketState("connecting");
    socket.addEventListener("open", () => setSocketState("open"));
    socket.addEventListener("close", () => setSocketState("closed"));
    socket.addEventListener("error", () => setSocketState("closed"));
    socket.addEventListener("message", (event) => {
      const payload = safeParseSocketMessage(event.data);

      if (
        payload?.type === "state.changed" ||
        payload?.type === "operations.changed" ||
        payload?.type === "worktrees.changed"
      ) {
        void refreshState({ silent: true });
      }
    });

    return () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen || !selectedRepository) {
      return;
    }

    setSettingsDraft(createSettingsDraft(selectedRepository.settings));
  }, [selectedRepository, settingsOpen]);

  async function boot(): Promise<void> {
    setLoadFailure(undefined);

    try {
      const desktop = await window.repobinderDesktop?.getDesktopContext().catch(() => undefined);
      const [nextServerInfo, nextState] = await Promise.all([
        api<ServerInfo>("/api/server"),
        api<AppStateResource>("/api/state"),
      ]);

      setDesktopContext(desktop);
      setServerInfo(nextServerInfo);
      setAppState(nextState);
    } catch (error) {
      setLoadFailure(toErrorMessage(error));
    }
  }

  async function refreshState(options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) {
      setBusyAction("refresh");
      setBanner(undefined);
    }

    try {
      const nextState = await api<AppStateResource>("/api/state");
      setAppState(nextState);
    } catch (error) {
      if (!options.silent) {
        setBanner({ tone: "danger", text: toErrorMessage(error) });
      }
    } finally {
      if (!options.silent) {
        setBusyAction(undefined);
      }
    }
  }

  async function addRepository(): Promise<void> {
    if (!window.repobinderDesktop || !desktopContext) {
      return;
    }

    setBusyAction("repository.add");
    setBanner(undefined);

    try {
      const repositoryPath = await window.repobinderDesktop.pickRepositoryFolder();

      if (!repositoryPath) {
        return;
      }

      const nextState = await api<AppStateResource>(
        "/api/repositories",
        {
          method: "POST",
          body: JSON.stringify({ repositoryPath }),
        },
        desktopContext,
      );

      setAppState(nextState);
      setBanner({ tone: "success", text: "Repository added" });
    } catch (error) {
      setBanner({ tone: "danger", text: toErrorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function selectRepository(repositoryId: string, worktreeId?: string): Promise<void> {
    setBusyAction(`selection:${worktreeId ?? repositoryId}`);

    try {
      const nextState = await api<AppStateResource>("/api/selection", {
        method: "PATCH",
        body: JSON.stringify({ repositoryId, worktreeId }),
      });

      setAppState(nextState);
      setMobileSidebarOpen(false);
    } catch (error) {
      setBanner({ tone: "danger", text: toErrorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  function openSettings(): void {
    if (!selectedRepository) {
      return;
    }

    setSettingsDraft(createSettingsDraft(selectedRepository.settings));
    setSettingsOpen(true);
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!selectedRepository || !settingsDraft) {
      return;
    }

    setBusyAction("settings.save");
    setBanner(undefined);

    try {
      const nextState = await api<AppStateResource>(`/api/repositories/${selectedRepository.repositoryId}/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          setup: {
            enabled: settingsDraft.setupEnabled,
            command: settingsDraft.command,
            defaultArgs: parseArgsText(settingsDraft.defaultArgsText),
            autoStartDevServer: settingsDraft.autoStartDevServer,
          },
        }),
      });

      setAppState(nextState);
      setSettingsOpen(false);
      setBanner({ tone: "success", text: "Repository Settings saved" });
    } catch (error) {
      setBanner({ tone: "danger", text: toErrorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function addExistingWorktree(): Promise<void> {
    if (!selectedRepository || !window.repobinderDesktop || !desktopContext) {
      return;
    }

    setBusyAction("worktree.add-existing");
    setBanner(undefined);

    try {
      const worktreePath = await window.repobinderDesktop.pickRepositoryFolder();

      if (!worktreePath) {
        return;
      }

      const nextState = await api<AppStateResource>(
        `/api/repositories/${selectedRepository.repositoryId}/worktrees/existing`,
        {
          method: "POST",
          body: JSON.stringify({ worktreePath }),
        },
        desktopContext,
      );

      setAppState(nextState);
      setBanner({ tone: "success", text: "Existing Linked Worktree added" });
    } catch (error) {
      setBanner({ tone: "danger", text: toErrorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function openNewWorktree(): Promise<void> {
    if (!selectedRepository) {
      return;
    }

    setNewWorktreeRows([""]);
    setNewWorktreeRowErrors({});
    setNewWorktreeContext(undefined);
    setNewWorktreeOpen(true);
    setNewWorktreeLoading(true);

    try {
      const context = await api<NewWorktreeContext>(
        `/api/repositories/${selectedRepository.repositoryId}/new-worktree-context`,
      );
      setNewWorktreeContext(context);
    } catch (error) {
      setNewWorktreeOpen(false);
      setBanner({ tone: "danger", text: toErrorMessage(error) });
    } finally {
      setNewWorktreeLoading(false);
    }
  }

  function updateNewWorktreeRow(index: number, value: string): void {
    setNewWorktreeRows((rows) => rows.map((row, rowIndex) => (rowIndex === index ? value : row)));
  }

  function addNewWorktreeRow(): void {
    setNewWorktreeRows((rows) => (rows.length >= 5 ? rows : [...rows, ""]));
  }

  function removeNewWorktreeRow(index: number): void {
    setNewWorktreeRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
    setNewWorktreeRowErrors({});
  }

  async function submitNewWorktree(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!selectedRepository) {
      return;
    }

    setBusyAction("worktree.create-batch");
    setBanner(undefined);
    setNewWorktreeRowErrors({});

    try {
      const response = await fetch(`/api/repositories/${selectedRepository.repositoryId}/worktrees`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: newWorktreeRows.map((branchName) => ({ branchName })) }),
      });
      const body = (await response.json().catch(() => undefined)) as
        | (BatchResponse & { error?: string; rows?: BatchValidationRow[] })
        | undefined;

      if (!response.ok) {
        if (response.status === 400 && Array.isArray(body?.rows)) {
          const errors: Record<number, string[]> = {};

          for (const row of body.rows) {
            errors[row.index] = row.errors;
          }

          setNewWorktreeRowErrors(errors);
          setBanner({ tone: "danger", text: body?.error ?? "New Worktree validation failed" });
          return;
        }

        throw new Error(typeof body?.error === "string" ? body.error : response.statusText);
      }

      if (body?.state) {
        setAppState(body.state);
      }

      setNewWorktreeOpen(false);

      const result = body?.result;

      if (!result || result.failed === 0) {
        setBanner({
          tone: "success",
          text: `Created ${result?.created ?? 0} Linked Worktree${result?.created === 1 ? "" : "s"}`,
        });
      } else if (result.created === 0) {
        setBanner({ tone: "danger", text: "No Linked Worktrees were created" });
      } else {
        setBanner({
          tone: "warning",
          text: `Created ${result.created} of ${result.created + result.failed}; ${result.failed} failed`,
        });
      }
    } catch (error) {
      setBanner({ tone: "danger", text: toErrorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  if (loadFailure) {
    return (
      <main className="bootScreen">
        <section className="bootPanel" aria-labelledby="startup-failed-title">
          <div className="brandMark" aria-hidden="true">
            <GitBranch size={22} />
          </div>
          <h1 id="startup-failed-title">RepoBinder</h1>
          <p>{loadFailure}</p>
          <button className="primaryButton inlineButton" type="button" onClick={() => void boot()}>
            <RefreshCw size={16} />
            <span>Retry</span>
          </button>
        </section>
      </main>
    );
  }

  if (!serverInfo || !appState) {
    return (
      <main className="bootScreen" aria-label="Loading RepoBinder">
        <div className="loadingMark">
          <RefreshCw size={22} className="spin" />
        </div>
      </main>
    );
  }

  return (
    <main className="dashboardShell">
      <aside className="sidebarFrame desktopSidebar" aria-label="Repositories">
        <SidebarContent
          appState={appState}
          selectedRepositoryId={selectedRepository?.repositoryId}
          selectedWorktreeId={selectedWorktreeId}
          isDesktop={isDesktop}
          isBusy={isBusy}
          onAddRepository={() => void addRepository()}
          onSelectRepository={(repositoryId, worktreeId) => void selectRepository(repositoryId, worktreeId)}
        />
      </aside>

      <section className="contentFrame">
        <header className="mobileTopBar">
          <button
            className="iconButton"
            type="button"
            aria-label="Open repositories"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu size={18} />
          </button>
          <div className="mobileTitle">
            <GitBranch size={18} />
            <span>RepoBinder</span>
          </div>
          <ConnectionPill socketState={socketState} remoteEnabled={serverInfo.remoteEnabled} />
        </header>

        <header className="contentHeader">
          <div className="titleStack">
            <p className="eyebrow">Selected Repository</p>
            <h1>{selectedRepository?.displayName ?? "Choose a Repository"}</h1>
            <code>{selectedRepository?.primaryWorktreePath ?? "No Repository selected"}</code>
          </div>

          <div className="headerActions">
            <ConnectionPill socketState={socketState} remoteEnabled={serverInfo.remoteEnabled} />
            <button
              className="iconButton"
              type="button"
              aria-label="Refresh"
              disabled={isBusy}
              onClick={() => void refreshState()}
            >
              <RefreshCw size={18} className={busyAction === "refresh" ? "spin" : undefined} />
            </button>
            <button
              className="primaryButton"
              type="button"
              disabled={!selectedRepository || isBusy}
              onClick={() => void openNewWorktree()}
            >
              <Plus size={17} />
              <span>New Worktree</span>
            </button>
            <button
              className="secondaryButton"
              type="button"
              disabled={!selectedRepository || isBusy}
              onClick={openSettings}
            >
              <Settings size={17} />
              <span>Settings</span>
            </button>
          </div>
        </header>

        {serverInfo.remoteEnabled ? (
          <BannerMessage tone="warning" text="Remote mode is trusted-network-only." icon={<Wifi size={17} />} />
        ) : null}
        {banner ? (
          <BannerMessage
            tone={banner.tone}
            text={banner.text}
            icon={banner.tone === "danger" || banner.tone === "warning" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
          />
        ) : null}

        {selectedRepository ? (
          <RepositoryDashboard
            repository={selectedRepository}
            selectedWorktree={selectedWorktree}
            selectedWorktreeId={selectedWorktreeId}
          />
        ) : (
          <section className="emptyDashboard" aria-labelledby="choose-repository-title">
            <FolderOpen size={44} />
            <h2 id="choose-repository-title">Choose a Repository</h2>
            {isDesktop ? (
              <button
                className="primaryButton inlineButton"
                type="button"
                disabled={isBusy}
                onClick={() => void addRepository()}
              >
                <Plus size={17} />
                <span>Add Repository</span>
              </button>
            ) : null}
          </section>
        )}
      </section>

      {mobileSidebarOpen ? (
        <div className="sheetLayer" role="presentation" onMouseDown={() => setMobileSidebarOpen(false)}>
          <aside
            className="mobileSidebarSheet"
            aria-label="Repositories"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="iconButton closeButton" type="button" aria-label="Close" onClick={() => setMobileSidebarOpen(false)}>
              <X size={18} />
            </button>
            <SidebarContent
              appState={appState}
              selectedRepositoryId={selectedRepository?.repositoryId}
              selectedWorktreeId={selectedWorktreeId}
              isDesktop={isDesktop}
              isBusy={isBusy}
              onAddRepository={() => void addRepository()}
              onSelectRepository={(repositoryId, worktreeId) => void selectRepository(repositoryId, worktreeId)}
            />
          </aside>
        </div>
      ) : null}

      {settingsOpen && selectedRepository && settingsDraft ? (
        <div className="sheetLayer" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settingsSheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="repository-settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheetHeader">
              <div>
                <p className="eyebrow">Repository</p>
                <h2 id="repository-settings-title">Settings</h2>
              </div>
              <button className="iconButton" type="button" aria-label="Close" onClick={() => setSettingsOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <form className="settingsForm" onSubmit={(event) => void saveSettings(event)}>
              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={settingsDraft.setupEnabled}
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      setupEnabled: event.target.checked,
                      autoStartDevServer: event.target.checked ? settingsDraft.autoStartDevServer : false,
                    })
                  }
                />
                <span>Enable Worktree Setup Script</span>
              </label>

              <label className="fieldStack">
                <span>Command</span>
                <input
                  value={settingsDraft.command}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, command: event.target.value })}
                  placeholder="scripts/setup-worktree"
                  disabled={!settingsDraft.setupEnabled}
                />
              </label>

              <label className="fieldStack">
                <span>Default args</span>
                <textarea
                  value={settingsDraft.defaultArgsText}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, defaultArgsText: event.target.value })}
                  placeholder="--install"
                  disabled={!settingsDraft.setupEnabled}
                  rows={5}
                />
              </label>

              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={settingsDraft.autoStartDevServer}
                  disabled={!settingsDraft.setupEnabled}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, autoStartDevServer: event.target.checked })}
                />
                <span>Auto Start Dev Server</span>
              </label>

              <div className="sheetActions">
                {isDesktop ? (
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={isBusy}
                    onClick={() => void addExistingWorktree()}
                  >
                    <FolderOpen size={17} />
                    <span>Add Existing Worktree</span>
                  </button>
                ) : null}
                <button className="secondaryButton" type="button" disabled={isBusy} onClick={() => setSettingsOpen(false)}>
                  Cancel
                </button>
                <button className="primaryButton inlineButton" type="submit" disabled={isBusy}>
                  <CheckCircle2 size={17} />
                  <span>Save</span>
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {newWorktreeOpen && selectedRepository ? (
        <div className="sheetLayer" role="presentation" onMouseDown={() => setNewWorktreeOpen(false)}>
          <section
            className="settingsSheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-worktree-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="sheetHeader">
              <div>
                <p className="eyebrow">{selectedRepository.displayName}</p>
                <h2 id="new-worktree-title">New Worktree</h2>
              </div>
              <button className="iconButton" type="button" aria-label="Close" onClick={() => setNewWorktreeOpen(false)}>
                <X size={18} />
              </button>
            </div>

            {newWorktreeLoading ? (
              <div className="sheetLoading" aria-label="Loading New Worktree context">
                <RefreshCw size={20} className="spin" />
              </div>
            ) : (
              <form className="settingsForm" onSubmit={(event) => void submitNewWorktree(event)}>
                {newWorktreeContext?.detached ? (
                  <BannerMessage
                    tone="warning"
                    text="The Primary Worktree is in a detached HEAD state. Check out a Branch to create new Linked Worktrees."
                    icon={<AlertTriangle size={17} />}
                  />
                ) : (
                  <div className="baseBranchRow">
                    <span className="fieldLabel">Base Branch</span>
                    <code className="baseBranchValue">
                      <GitBranch size={14} />
                      {newWorktreeContext?.baseBranch ?? "Unknown"}
                    </code>
                  </div>
                )}

                {newWorktreeContext?.dirty ? (
                  <BannerMessage
                    tone="warning"
                    text="The Primary Worktree has uncommitted changes. They will not be copied into the new Linked Worktrees."
                    icon={<AlertTriangle size={17} />}
                  />
                ) : null}

                <div className="branchRowList">
                  {newWorktreeRows.map((row, index) => (
                    <div className="branchRow" key={index}>
                      <label className="fieldStack">
                        <span>{index === 0 ? "Branch name (required)" : `Branch name ${index + 1}`}</span>
                        <div className="branchRowInput">
                          <input
                            value={row}
                            onChange={(event) => updateNewWorktreeRow(index, event.target.value)}
                            placeholder={index === 0 ? "feature/search" : `auto: ${newWorktreeRows[0] || "branch"}-${index + 1}`}
                            aria-invalid={(newWorktreeRowErrors[index]?.length ?? 0) > 0}
                          />
                          {index > 0 ? (
                            <button
                              className="iconButton"
                              type="button"
                              aria-label={`Remove Branch row ${index + 1}`}
                              onClick={() => removeNewWorktreeRow(index)}
                            >
                              <X size={16} />
                            </button>
                          ) : null}
                        </div>
                      </label>
                      {(newWorktreeRowErrors[index] ?? []).map((error, errorIndex) => (
                        <p className="rowError" key={errorIndex}>
                          {error}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>

                {newWorktreeRows.length < 5 ? (
                  <button className="secondaryButton" type="button" onClick={addNewWorktreeRow}>
                    <Plus size={16} />
                    <span>Add Worktree row</span>
                  </button>
                ) : null}

                <div className="sheetActions">
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={isBusy}
                    onClick={() => setNewWorktreeOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="primaryButton inlineButton"
                    type="submit"
                    disabled={isBusy || newWorktreeContext?.detached || !newWorktreeRows[0]?.trim()}
                  >
                    <Plus size={17} />
                    <span>Create</span>
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}

function SidebarContent(props: {
  appState: AppStateResource;
  selectedRepositoryId?: string;
  selectedWorktreeId?: string;
  isDesktop: boolean;
  isBusy: boolean;
  onAddRepository: () => void;
  onSelectRepository: (repositoryId: string, worktreeId?: string) => void;
}): JSX.Element {
  return (
    <div className="sidebarContent">
      <div className="sidebarBrand">
        <div className="brandMark" aria-hidden="true">
          <GitBranch size={20} />
        </div>
        <div>
          <h2>RepoBinder</h2>
          <p>{props.appState.repositories.length} Repositories</p>
        </div>
      </div>

      {props.isDesktop ? (
        <button className="primaryButton" type="button" disabled={props.isBusy} onClick={props.onAddRepository}>
          <Plus size={17} />
          <span>Add Repository</span>
        </button>
      ) : null}

      <nav className="repositoryNav" aria-label="Repository groups">
        {props.appState.repositories.length > 0 ? (
          props.appState.repositories.map((repository) => (
            <RepositoryNavGroup
              key={repository.repositoryId}
              repository={repository}
              selectedRepositoryId={props.selectedRepositoryId}
              selectedWorktreeId={props.selectedWorktreeId}
              disabled={props.isBusy}
              onSelect={props.onSelectRepository}
            />
          ))
        ) : (
          <div className="sidebarEmpty">
            <FolderOpen size={26} />
            <span>No Repositories</span>
          </div>
        )}
      </nav>
    </div>
  );
}

function RepositoryNavGroup(props: {
  repository: RepositoryResource;
  selectedRepositoryId?: string;
  selectedWorktreeId?: string;
  disabled: boolean;
  onSelect: (repositoryId: string, worktreeId?: string) => void;
}): JSX.Element {
  const isSelectedRepository = props.repository.repositoryId === props.selectedRepositoryId;

  return (
    <div className="repositoryGroup">
      <button
        className={`repositoryButton ${isSelectedRepository ? "selected" : ""}`}
        type="button"
        disabled={props.disabled}
        aria-pressed={isSelectedRepository}
        onClick={() => props.onSelect(props.repository.repositoryId)}
      >
        <ChevronRight size={15} className={isSelectedRepository ? "chevronOpen" : undefined} />
        <span>{props.repository.displayName}</span>
        <small>{props.repository.worktrees.length}</small>
      </button>

      <div className="worktreeNavList">
        {props.repository.worktrees.map((worktree) => {
          const isSelectedWorktree = worktree.worktreeId === props.selectedWorktreeId;

          return (
            <button
              className={`worktreeNavButton ${isSelectedWorktree ? "selected" : ""}`}
              type="button"
              key={worktree.worktreeId}
              disabled={props.disabled}
              aria-pressed={isSelectedWorktree}
              onClick={() => props.onSelect(props.repository.repositoryId, worktree.worktreeId)}
            >
              <StatusDot status={worktree.availability === "available" ? "success" : "warning"} />
              <span>{worktree.branch ?? "Detached HEAD"}</span>
              <small>{worktree.type === "primary" ? "Primary" : "Linked"}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RepositoryDashboard(props: {
  repository: RepositoryResource;
  selectedWorktree?: WorktreeResource;
  selectedWorktreeId?: string;
}): JSX.Element {
  const linkedCount = props.repository.worktrees.filter((worktree) => worktree.type === "linked").length;

  return (
    <div className="repositoryDashboard">
      <section className="metricsBand" aria-label="Repository summary">
        <Metric label="Tracked Worktrees" value={props.repository.worktrees.length} />
        <Metric label="Linked Worktrees" value={linkedCount} />
        <Metric label="Selected Branch" value={props.selectedWorktree?.branch ?? "Detached"} />
      </section>

      <section className="worktreeSurface" aria-labelledby="worktrees-title">
        <div className="surfaceHeader">
          <div>
            <p className="eyebrow">Tracked Worktrees</p>
            <h2 id="worktrees-title">Worktrees</h2>
          </div>
          <span className="countBadge">{props.repository.worktrees.length}</span>
        </div>

        <div className="worktreeTable" role="table" aria-label="Tracked Worktrees">
          <div className="worktreeTableHeader" role="row">
            <span role="columnheader">Branch</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Worktree Path</span>
            <span role="columnheader">Setup</span>
            <span role="columnheader">Dev Server</span>
          </div>

          {props.repository.worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.worktreeId}
              worktree={worktree}
              selected={worktree.worktreeId === props.selectedWorktreeId}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function WorktreeRow(props: { worktree: WorktreeResource; selected: boolean }): JSX.Element {
  return (
    <article className={`worktreeRow ${props.selected ? "selected" : ""}`} role="row">
      <div className="branchCell" role="cell">
        <GitBranch size={16} />
        <div>
          <strong>{props.worktree.branch ?? "Detached HEAD"}</strong>
          <small>{props.worktree.head ? props.worktree.head.slice(0, 7) : "No HEAD"}</small>
        </div>
      </div>
      <div role="cell">
        <StatusBadge tone={props.worktree.type === "primary" ? "neutral" : "info"} text={props.worktree.type === "primary" ? "Primary" : "Linked"} />
      </div>
      <code role="cell">{props.worktree.worktreePath}</code>
      <div role="cell">
        <StatusBadge tone={setupTone(props.worktree.setup.status)} text={formatSetupStatus(props.worktree.setup.status)} />
      </div>
      <div role="cell">
        <StatusBadge tone={devServerTone(props.worktree.devServer?.status)} text={formatDevServer(props.worktree.devServer)} />
      </div>
    </article>
  );
}

function ConnectionPill(props: { socketState: SocketState; remoteEnabled: boolean }): JSX.Element {
  if (props.remoteEnabled) {
    return <StatusPill icon={<Wifi size={15} />} tone="warning" label="Remote" />;
  }

  return props.socketState === "open" ? (
    <StatusPill icon={<Server size={15} />} tone="success" label="Live" />
  ) : (
    <StatusPill icon={<WifiOff size={15} />} tone="danger" label="Offline" />
  );
}

function StatusPill(props: { icon: JSX.Element; label: string; tone: "neutral" | "success" | "warning" | "danger" }) {
  return (
    <span className={`statusPill ${props.tone}`}>
      {props.icon}
      {props.label}
    </span>
  );
}

function StatusBadge(props: { tone: "neutral" | "success" | "warning" | "danger" | "info"; text: string }): JSX.Element {
  return <span className={`statusBadge ${props.tone}`}>{props.text}</span>;
}

function StatusDot(props: { status: "success" | "warning" | "danger" | "neutral" }): JSX.Element {
  return <span className={`statusDot ${props.status}`} aria-hidden="true" />;
}

function Metric(props: { label: string; value: number | string }): JSX.Element {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function BannerMessage(props: { icon: JSX.Element; text: string; tone: Banner["tone"] }): JSX.Element {
  return (
    <div className={`feedback ${props.tone}`} role={props.tone === "danger" ? "alert" : "status"}>
      {props.icon}
      <span>{props.text}</span>
    </div>
  );
}

async function api<T>(pathName: string, init: RequestInit = {}, desktopContext?: DesktopContext): Promise<T> {
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

function createSettingsDraft(settings: RepositorySettings): SettingsDraft {
  return {
    setupEnabled: settings.setup.enabled,
    command: settings.setup.command ?? "",
    defaultArgsText: settings.setup.defaultArgs.join("\n"),
    autoStartDevServer: settings.setup.autoStartDevServer,
  };
}

function parseArgsText(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatSetupStatus(status: SetupStatus): string {
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

function setupTone(status: SetupStatus): "neutral" | "success" | "warning" | "danger" | "info" {
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

function formatDevServer(devServer: WorktreeResource["devServer"]): string {
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

function devServerTone(status: DevServerStatus | undefined): "neutral" | "success" | "warning" | "danger" | "info" {
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

function safeParseSocketMessage(data: unknown): { type?: string } | undefined {
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error";
}
