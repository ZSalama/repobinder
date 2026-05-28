import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  GitBranch,
  GitCommit,
  Monitor,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Worktree = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
};

type RepositoryInspection = {
  repositoryPath: string;
  worktrees: Worktree[];
  branches: string[];
};

type ServerInfo = {
  name: string;
  host: string;
  port: number;
  remoteEnabled: boolean;
  advertisedUrls: string[];
};

type SocketState = "connecting" | "open" | "closed";

const repositoryStorageKey = "repobinder.repositoryPath";

export function App(): JSX.Element {
  const [serverInfo, setServerInfo] = useState<ServerInfo | undefined>();
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [repositoryPath, setRepositoryPath] = useState(() => localStorage.getItem(repositoryStorageKey) || "");
  const [inspection, setInspection] = useState<RepositoryInspection | undefined>();
  const [worktreePath, setWorktreePath] = useState("");
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api<ServerInfo>("/api/server").then(setServerInfo).catch((apiError: unknown) => {
      setError(toErrorMessage(apiError));
    });
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

      if (payload?.type === "worktrees.changed" && inspection?.repositoryPath === payload.repositoryPath) {
        inspect(payload.repositoryPath, { silent: true }).catch((apiError: unknown) => {
          setError(toErrorMessage(apiError));
        });
      }
    });

    return () => {
      socket.close();
    };
  }, [inspection?.repositoryPath]);

  const primaryPath = inspection?.worktrees[0]?.path;
  const worktreeCount = inspection?.worktrees.length ?? 0;
  const branchCount = inspection?.branches.length ?? 0;

  const branchOptions = useMemo(() => {
    const options = new Set(inspection?.branches ?? []);

    if (branchName) {
      options.add(branchName);
    }

    return [...options].sort((left, right) => left.localeCompare(right));
  }, [branchName, inspection?.branches]);

  async function inspect(pathToInspect = repositoryPath, options: { silent?: boolean } = {}): Promise<void> {
    if (!pathToInspect.trim()) {
      setError("Repository path is required");
      return;
    }

    setBusy(true);
    setError(undefined);

    if (!options.silent) {
      setMessage(undefined);
    }

    try {
      const nextInspection = await api<RepositoryInspection>("/api/repositories/inspect", {
        method: "POST",
        body: JSON.stringify({ repositoryPath: pathToInspect }),
      });

      setInspection(nextInspection);
      setRepositoryPath(nextInspection.repositoryPath);
      localStorage.setItem(repositoryStorageKey, nextInspection.repositoryPath);

      if (!options.silent) {
        setMessage(`Loaded ${nextInspection.repositoryPath}`);
      }
    } catch (apiError) {
      setError(toErrorMessage(apiError));
    } finally {
      setBusy(false);
    }
  }

  async function createWorktree(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (!inspection) {
      setError("Load a repository first");
      return;
    }

    setBusy(true);
    setError(undefined);
    setMessage(undefined);

    try {
      const nextInspection = await api<RepositoryInspection>("/api/worktrees", {
        method: "POST",
        body: JSON.stringify({
          repositoryPath: inspection.repositoryPath,
          worktreePath,
          branchName,
          baseRef,
          createBranch,
        }),
      });

      setInspection(nextInspection);
      setWorktreePath("");
      setBranchName("");
      setBaseRef("");
      setMessage("Worktree created");
    } catch (apiError) {
      setError(toErrorMessage(apiError));
    } finally {
      setBusy(false);
    }
  }

  async function removeWorktree(targetPath: string): Promise<void> {
    if (!inspection) {
      return;
    }

    if (!window.confirm(`Remove ${targetPath}?`)) {
      return;
    }

    setBusy(true);
    setError(undefined);
    setMessage(undefined);

    try {
      const nextInspection = await api<RepositoryInspection>("/api/worktrees/remove", {
        method: "POST",
        body: JSON.stringify({
          repositoryPath: inspection.repositoryPath,
          worktreePath: targetPath,
        }),
      });

      setInspection(nextInspection);
      setMessage("Worktree removed");
    } catch (apiError) {
      setError(toErrorMessage(apiError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div className="brandBlock">
          <div className="brandMark" aria-hidden="true">
            <GitBranch size={20} />
          </div>
          <div>
            <h1>RepoBinder</h1>
            <p>{inspection?.repositoryPath || "No repository loaded"}</p>
          </div>
        </div>

        <div className="statusStrip">
          <StatusPill
            icon={serverInfo?.remoteEnabled ? <Wifi size={16} /> : <Monitor size={16} />}
            tone={serverInfo?.remoteEnabled ? "warning" : "neutral"}
            label={serverInfo?.remoteEnabled ? "Network" : "Local"}
          />
          <StatusPill
            icon={socketState === "open" ? <Server size={16} /> : <WifiOff size={16} />}
            tone={socketState === "open" ? "success" : "danger"}
            label={socketState === "open" ? "Live" : "Offline"}
          />
        </div>
      </header>

      <section className="metricsBand" aria-label="Repository summary">
        <Metric label="Worktrees" value={worktreeCount} />
        <Metric label="Branches" value={branchCount} />
        <Metric label="Port" value={serverInfo?.port ?? "--"} />
      </section>

      <section className="workspaceGrid">
        <aside className="controlPanel">
          <form className="stack" onSubmit={(event) => void submitInspect(event, inspect)}>
            <label>
              <span>Repository path</span>
              <input
                value={repositoryPath}
                onChange={(event) => setRepositoryPath(event.target.value)}
                placeholder="/path/to/repository"
                autoComplete="off"
              />
            </label>

            <button className="primaryButton" type="submit" disabled={busy}>
              {busy ? <RefreshCw size={18} className="spin" /> : <FolderOpen size={18} />}
              <span>Load Repository</span>
            </button>
          </form>

          <form className="stack divider" onSubmit={(event) => void createWorktree(event)}>
            <label>
              <span>Worktree path</span>
              <input
                value={worktreePath}
                onChange={(event) => setWorktreePath(event.target.value)}
                placeholder="/path/to/new-worktree"
                autoComplete="off"
              />
            </label>

            <label>
              <span>Branch or ref</span>
              <input
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="feature/branch-name"
                list="branch-options"
                autoComplete="off"
              />
            </label>

            <datalist id="branch-options">
              {branchOptions.map((branch) => (
                <option value={branch} key={branch} />
              ))}
            </datalist>

            <label>
              <span>Base ref</span>
              <input
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                placeholder="main"
                autoComplete="off"
              />
            </label>

            <label className="checkboxRow">
              <input
                type="checkbox"
                checked={createBranch}
                onChange={(event) => setCreateBranch(event.target.checked)}
              />
              <span>Create branch</span>
            </label>

            <button className="primaryButton" type="submit" disabled={busy || !inspection}>
              <Plus size={18} />
              <span>Create Worktree</span>
            </button>
          </form>

          {serverInfo?.remoteEnabled ? (
            <div className="networkPanel">
              <div className="sectionLabel">Remote URLs</div>
              {serverInfo.advertisedUrls.map((url) => (
                <code key={url}>{url}</code>
              ))}
            </div>
          ) : null}
        </aside>

        <section className="worktreeSurface">
          <div className="surfaceHeader">
            <div>
              <h2>Worktrees</h2>
              <p>{inspection ? inspection.repositoryPath : "Load a repository to begin"}</p>
            </div>
            <button
              className="iconButton"
              type="button"
              title="Refresh"
              aria-label="Refresh"
              disabled={busy || !inspection}
              onClick={() => void inspect(inspection?.repositoryPath)}
            >
              <RefreshCw size={18} className={busy ? "spin" : undefined} />
            </button>
          </div>

          {message ? (
            <Feedback tone="success" icon={<CheckCircle2 size={18} />} text={message} />
          ) : null}
          {error ? (
            <Feedback tone="danger" icon={<AlertTriangle size={18} />} text={error} />
          ) : null}

          <div className="worktreeList">
            {inspection ? (
              inspection.worktrees.map((worktree) => {
                const isPrimary = worktree.path === primaryPath;

                return (
                  <article className="worktreeCard" key={worktree.path}>
                    <div className="worktreeMain">
                      <div className="worktreeIcon" aria-hidden="true">
                        <GitBranch size={18} />
                      </div>
                      <div className="worktreeText">
                        <div className="worktreeTitle">
                          <span>{worktree.branch || "Detached HEAD"}</span>
                          {isPrimary ? <strong>Primary</strong> : null}
                          {worktree.locked ? <strong>Locked</strong> : null}
                        </div>
                        <code>{worktree.path}</code>
                      </div>
                    </div>

                    <div className="worktreeMeta">
                      <span title={worktree.head || "No HEAD"}>
                        <GitCommit size={14} />
                        {shortSha(worktree.head)}
                      </span>
                      <button
                        className="dangerButton"
                        type="button"
                        disabled={busy || isPrimary}
                        title={isPrimary ? "Primary worktree cannot be removed" : "Remove worktree"}
                        onClick={() => void removeWorktree(worktree.path)}
                      >
                        <Trash2 size={16} />
                        <span>Remove</span>
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="emptyState">
                <FolderOpen size={42} />
                <span>No repository selected</span>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
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

function Metric(props: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Feedback(props: { icon: JSX.Element; text: string; tone: "success" | "danger" }) {
  return (
    <div className={`feedback ${props.tone}`}>
      {props.icon}
      <span>{props.text}</span>
    </div>
  );
}

async function submitInspect(
  event: FormEvent<HTMLFormElement>,
  inspect: (pathToInspect?: string) => Promise<void>,
): Promise<void> {
  event.preventDefault();
  await inspect();
}

async function api<T>(pathName: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(pathName, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(typeof body?.error === "string" ? body.error : response.statusText);
  }

  return response.json() as Promise<T>;
}

function safeParseSocketMessage(data: unknown): { type?: string; repositoryPath?: string } | undefined {
  if (typeof data !== "string") {
    return undefined;
  }

  try {
    const value = JSON.parse(data) as unknown;

    if (typeof value === "object" && value !== null) {
      return value as { type?: string; repositoryPath?: string };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function shortSha(head: string | undefined): string {
  return head ? head.slice(0, 7) : "unknown";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error";
}
