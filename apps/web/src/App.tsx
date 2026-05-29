import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  GitBranch,
  History,
  Menu,
  Plus,
  RefreshCw,
  Settings,
  Wifi,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { ActivitySheet } from "@/components/activity-sheet";
import { BannerMessage } from "@/components/banner-message";
import { ConnectionPill } from "@/components/connection-pill";
import { DeleteWorktreeDialog } from "@/components/delete-worktree-dialog";
import { MobileSidebarSheet } from "@/components/mobile-sidebar-sheet";
import { NewWorktreeSheet } from "@/components/new-worktree-sheet";
import { RepositoryDashboard } from "@/components/repository-dashboard";
import { SettingsSheet } from "@/components/settings-sheet";
import { SidebarContent } from "@/components/sidebar-content";
import { api, safeParseSocketMessage, toErrorMessage } from "@/lib/api";
import { createSettingsDraft, parseArgsText } from "@/lib/format";
import {
  AppStateResource,
  Banner,
  BatchResponse,
  BatchValidationRow,
  DeleteWorktreeResponse,
  DesktopContext,
  NewWorktreeContext,
  OpenDevResponse,
  OperationRecord,
  ServerInfo,
  SettingsDraft,
  SocketState,
  WorktreeResource,
} from "@/types";

export function App(): JSX.Element {
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>();
  const [desktopContext, setDesktopContext] = useState<DesktopContext | undefined>();
  const [appState, setAppState] = useState<AppStateResource | undefined>();
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [loadFailure, setLoadFailure] = useState<string | undefined>();
  const [busyAction, setBusyAction] = useState<string | undefined>();
  const [banner, setBanner] = useState<Banner | undefined>();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | undefined>();
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [newWorktreeContext, setNewWorktreeContext] = useState<NewWorktreeContext | undefined>();
  const [newWorktreeLoading, setNewWorktreeLoading] = useState(false);
  const [newWorktreeRows, setNewWorktreeRows] = useState<string[]>([""]);
  const [newWorktreeRowArgs, setNewWorktreeRowArgs] = useState<string[]>([""]);
  const [newWorktreeSharedArgs, setNewWorktreeSharedArgs] = useState<string>("");
  const [newWorktreeRowErrors, setNewWorktreeRowErrors] = useState<Record<number, string[]>>({});
  const [deleteTarget, setDeleteTarget] = useState<WorktreeResource | undefined>();

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
  const pollRef = useRef<{ busy: boolean; repositoryId?: string }>({ busy: false });
  const seenOperationIdsRef = useRef<Set<string>>(new Set());
  const operationsInitializedRef = useRef(false);
  const settingsDraftRepositoryIdRef = useRef<string | undefined>();
  pollRef.current = { busy: isBusy, repositoryId: selectedRepository?.repositoryId };

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
    if (!banner) {
      return;
    }

    const duration = banner.tone === "success" || banner.tone === "info" ? 5_000 : 12_000;
    const bannerKey = `${banner.tone}:${banner.text}`;
    const timeout = window.setTimeout(() => {
      setBanner((current) => {
        if (!current || `${current.tone}:${current.text}` !== bannerKey) {
          return current;
        }

        return undefined;
      });
    }, duration);

    return () => window.clearTimeout(timeout);
  }, [banner]);

  useEffect(() => {
    if (!appState) {
      return;
    }

    if (!operationsInitializedRef.current) {
      seenOperationIdsRef.current = new Set(appState.operations.map((operation) => operation.operationId));
      operationsInitializedRef.current = true;
      return;
    }

    const unseenOperations = appState.operations.filter(
      (operation) => !seenOperationIdsRef.current.has(operation.operationId),
    );

    for (const operation of unseenOperations) {
      seenOperationIdsRef.current.add(operation.operationId);
    }

    const latestCompletedOperation = unseenOperations.find((operation) => operation.status !== "pending");

    if (latestCompletedOperation) {
      setBanner(operationToBanner(latestCompletedOperation));
    }
  }, [appState]);

  useEffect(() => {
    let lastFocusRefreshAt = 0;

    const refreshAfterFocus = () => {
      const now = Date.now();

      if (now - lastFocusRefreshAt < 1_500) {
        return;
      }

      lastFocusRefreshAt = now;

      if (!pollRef.current.busy) {
        void refreshSelectedRepository({ silent: true });
      }
    };
    const refreshAfterVisibility = () => {
      if (!document.hidden) {
        refreshAfterFocus();
      }
    };

    window.addEventListener("focus", refreshAfterFocus);
    document.addEventListener("visibilitychange", refreshAfterVisibility);

    return () => {
      window.removeEventListener("focus", refreshAfterFocus);
      document.removeEventListener("visibilitychange", refreshAfterVisibility);
    };
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
    if (!settingsOpen) {
      settingsDraftRepositoryIdRef.current = undefined;
      setSettingsDraft(undefined);
      return;
    }

    if (!selectedRepository || settingsDraftRepositoryIdRef.current === selectedRepository.repositoryId) {
      return;
    }

    settingsDraftRepositoryIdRef.current = selectedRepository.repositoryId;
    setSettingsDraft(createSettingsDraft(selectedRepository.settings));
  }, [selectedRepository, settingsOpen]);

  // Light status polling for the Selected Repository so the dashboard notices
  // stale Dev Servers without aggressive polling for every Repository.
  useEffect(() => {
    const interval = setInterval(() => {
      const { busy, repositoryId } = pollRef.current;

      if (!busy && repositoryId) {
        void refreshWorktreeStatus(repositoryId);
      }
    }, 10_000);

    return () => clearInterval(interval);
  }, []);

  async function boot(): Promise<void> {
    setLoadFailure(undefined);

    try {
      const desktop = await window.repobinderDesktop?.getDesktopContext().catch(() => undefined);
      const [nextServerInfo, nextState] = await Promise.all([
        api<ServerInfo>("/api/server"),
        api<AppStateResource>("/api/state"),
      ]);

      if (!operationsInitializedRef.current) {
        seenOperationIdsRef.current = new Set(nextState.operations.map((operation) => operation.operationId));
        operationsInitializedRef.current = true;
      }
      setDesktopContext(desktop);
      setServerInfo(nextServerInfo);
      setAppState(nextState);
      void refreshRepositoryForState(nextState, { silent: true });
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

  async function refreshSelectedRepository(options: { silent?: boolean } = {}): Promise<void> {
    const repositoryId = pollRef.current.repositoryId;

    if (!repositoryId) {
      await refreshState(options);
      return;
    }

    await refreshRepository(repositoryId, options);
  }

  async function refreshRepositoryForState(
    state: AppStateResource,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    const repositoryId = state.selection.repositoryId ?? state.repositories[0]?.repositoryId;

    if (repositoryId) {
      await refreshRepository(repositoryId, options);
    }
  }

  async function refreshRepository(repositoryId: string, options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) {
      setBusyAction("refresh");
      setBanner(undefined);
    }

    try {
      const refreshedState = await api<AppStateResource>(`/api/repositories/${repositoryId}/refresh`, {
        method: "POST",
      });
      setAppState(refreshedState);
      await refreshWorktreeStatus(repositoryId);
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

  async function refreshWorktreeStatus(repositoryId: string): Promise<void> {
    try {
      const nextState = await api<AppStateResource>(`/api/repositories/${repositoryId}/worktree-status`, {
        method: "POST",
      });
      setAppState(nextState);
    } catch {
      // Status polling is best-effort and stays silent on failure.
    }
  }

  async function openDevServer(worktreeId: string): Promise<void> {
    if (!selectedRepository) {
      return;
    }

    try {
      const result = await api<OpenDevResponse>(
        `/api/repositories/${selectedRepository.repositoryId}/worktrees/${worktreeId}/open-dev`,
        { method: "POST" },
      );

      const desktopBridge = window.repobinderDesktop;
      const shouldCopy = Boolean(desktopBridge);
      const actionSucceeded = desktopBridge
        ? await desktopBridge.copyDevServerUrl(result.url)
        : Boolean(window.open(result.url, "_blank", "noopener,noreferrer"));

      if (!actionSucceeded) {
        setBanner({
          tone: "warning",
          text: shouldCopy ? "Could not copy the Dev Server URL" : "Could not open the Dev Server URL",
        });
      } else if (!result.reachable) {
        setBanner({
          tone: "warning",
          text: shouldCopy
            ? "Dev Server URL copied, but it is not reachable from the RepoBinder host"
            : "Dev Server is not reachable from the RepoBinder host",
        });
      } else if (shouldCopy) {
        setBanner({ tone: "success", text: "Dev Server URL copied to clipboard" });
      }
    } catch (error) {
      setBanner({ tone: "danger", text: toErrorMessage(error) });
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
      void refreshRepositoryForState(nextState, { silent: true });
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
      void refreshRepository(repositoryId, { silent: true });
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

    settingsDraftRepositoryIdRef.current = selectedRepository.repositoryId;
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
            tailscaleRouting: settingsDraft.tailscaleRouting,
          },
        }),
      });

      setAppState(nextState);
      setSettingsOpen(false);
      void refreshRepositoryForState(nextState, { silent: true });
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
      void refreshRepositoryForState(nextState, { silent: true });
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
    setNewWorktreeRowArgs([""]);
    setNewWorktreeSharedArgs("");
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

  function updateNewWorktreeRowArgs(index: number, value: string): void {
    setNewWorktreeRowArgs((rows) => rows.map((row, rowIndex) => (rowIndex === index ? value : row)));
  }

  function addNewWorktreeRow(): void {
    setNewWorktreeRows((rows) => (rows.length >= 5 ? rows : [...rows, ""]));
    setNewWorktreeRowArgs((rows) => (rows.length >= 5 ? rows : [...rows, ""]));
  }

  function removeNewWorktreeRow(index: number): void {
    setNewWorktreeRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
    setNewWorktreeRowArgs((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
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
        body: JSON.stringify({
          rows: newWorktreeRows.map((branchName, index) => ({
            branchName,
            args: parseArgsText(newWorktreeRowArgs[index] ?? ""),
          })),
          sharedArgs: parseArgsText(newWorktreeSharedArgs),
        }),
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
        void refreshRepositoryForState(body.state, { silent: true });
      }

      setNewWorktreeOpen(false);
    } catch (error) {
      setBanner({ tone: "danger", text: toErrorMessage(error) });
    } finally {
      setBusyAction(undefined);
    }
  }

  async function deleteLinkedWorktree(deleteBranch: boolean): Promise<void> {
    if (!selectedRepository || !deleteTarget) {
      return;
    }

    setBusyAction(`worktree.delete:${deleteTarget.worktreeId}`);
    setBanner(undefined);

    try {
      const response = await api<DeleteWorktreeResponse>(
        `/api/repositories/${selectedRepository.repositoryId}/worktrees/${deleteTarget.worktreeId}`,
        {
          method: "DELETE",
          body: JSON.stringify({ deleteBranch }),
        },
      );

      setAppState(response.state);
      setDeleteTarget(undefined);
      void refreshRepositoryForState(response.state, { silent: true });
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
              onClick={() => void refreshSelectedRepository()}
            >
              <RefreshCw size={18} className={busyAction === "refresh" ? "spin" : undefined} />
            </button>
            <button className="secondaryButton" type="button" onClick={() => setActivityOpen(true)}>
              <History size={17} />
              <span>Activity</span>
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
          <BannerMessage
            tone="warning"
            text="Remote mode is enabled. Use RepoBinder only on a trusted network."
            icon={<Wifi size={17} />}
          />
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
            isBusy={isBusy}
            devServerAction={isDesktop ? "copy" : "open"}
            onOpenDev={(worktreeId) => void openDevServer(worktreeId)}
            onRequestDelete={setDeleteTarget}
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
        <MobileSidebarSheet
          appState={appState}
          selectedRepositoryId={selectedRepository?.repositoryId}
          selectedWorktreeId={selectedWorktreeId}
          isDesktop={isDesktop}
          isBusy={isBusy}
          onClose={() => setMobileSidebarOpen(false)}
          onAddRepository={() => void addRepository()}
          onSelectRepository={(repositoryId, worktreeId) => void selectRepository(repositoryId, worktreeId)}
        />
      ) : null}

      {activityOpen ? <ActivitySheet operations={appState.operations} onClose={() => setActivityOpen(false)} /> : null}

      {settingsOpen && selectedRepository && settingsDraft ? (
        <SettingsSheet
          settingsDraft={settingsDraft}
          setSettingsDraft={setSettingsDraft}
          isBusy={isBusy}
          isDesktop={isDesktop}
          onClose={() => setSettingsOpen(false)}
          onSubmit={(event) => void saveSettings(event)}
          onAddExistingWorktree={() => void addExistingWorktree()}
        />
      ) : null}

      {newWorktreeOpen && selectedRepository ? (
        <NewWorktreeSheet
          displayName={selectedRepository.displayName}
          loading={newWorktreeLoading}
          context={newWorktreeContext}
          rows={newWorktreeRows}
          rowArgs={newWorktreeRowArgs}
          sharedArgs={newWorktreeSharedArgs}
          rowErrors={newWorktreeRowErrors}
          isBusy={isBusy}
          onClose={() => setNewWorktreeOpen(false)}
          onSubmit={(event) => void submitNewWorktree(event)}
          onUpdateRow={updateNewWorktreeRow}
          onUpdateRowArgs={updateNewWorktreeRowArgs}
          onUpdateSharedArgs={setNewWorktreeSharedArgs}
          onAddRow={addNewWorktreeRow}
          onRemoveRow={removeNewWorktreeRow}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteWorktreeDialog
          worktree={deleteTarget}
          isBusy={isBusy}
          onClose={() => setDeleteTarget(undefined)}
          onConfirm={(deleteBranch) => void deleteLinkedWorktree(deleteBranch)}
        />
      ) : null}
    </main>
  );
}

function operationToBanner(operation: OperationRecord): Banner {
  return {
    tone: operation.severity === "error" ? "danger" : operation.severity,
    text: operation.summary,
  };
}
