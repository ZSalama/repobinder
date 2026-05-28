import { ExternalLink, GitBranch, Trash2 } from "lucide-react";

import { Metric, StatusBadge } from "@/components/status-display";
import { devServerTone, formatDevServer, formatSetupStatus, setupTone } from "@/lib/format";
import { RepositoryResource, WorktreeResource } from "@/types";

export function RepositoryDashboard(props: {
  repository: RepositoryResource;
  selectedWorktree?: WorktreeResource;
  selectedWorktreeId?: string;
  isBusy: boolean;
  onOpenDev: (worktreeId: string) => void;
  onRequestDelete: (worktree: WorktreeResource) => void;
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
            <span role="columnheader">Actions</span>
          </div>

          {props.repository.worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.worktreeId}
              worktree={worktree}
              selected={worktree.worktreeId === props.selectedWorktreeId}
              isBusy={props.isBusy}
              onOpenDev={props.onOpenDev}
              onRequestDelete={props.onRequestDelete}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function WorktreeRow(props: {
  worktree: WorktreeResource;
  selected: boolean;
  isBusy: boolean;
  onOpenDev: (worktreeId: string) => void;
  onRequestDelete: (worktree: WorktreeResource) => void;
}): JSX.Element {
  const { worktree } = props;
  const runningProcesses = worktree.trackedProcesses.filter((process) => process.status === "running");
  const canOpenDev = isOpenDevActionable(worktree);

  return (
    <article className={`worktreeRow ${props.selected ? "selected" : ""}`} role="row">
      <div className="branchCell" role="cell">
        <GitBranch size={16} />
        <div>
          <strong>{worktree.branch ?? "Detached HEAD"}</strong>
          <small>{worktree.head ? worktree.head.slice(0, 7) : "No HEAD"}</small>
        </div>
      </div>
      <div role="cell">
        <StatusBadge
          tone={worktree.type === "primary" ? "neutral" : "info"}
          text={worktree.type === "primary" ? "Primary" : "Linked"}
        />
      </div>
      <code role="cell">{worktree.worktreePath}</code>
      <div role="cell">
        <StatusBadge tone={setupTone(worktree.setup.status)} text={formatSetupStatus(worktree.setup.status)} />
      </div>
      <div className="devServerCell" role="cell">
        <StatusBadge tone={devServerTone(worktree.devServer?.status)} text={formatDevServer(worktree.devServer)} />
        {runningProcesses.length > 0 ? (
          <span className="processMeta">
            {runningProcesses.length} process{runningProcesses.length === 1 ? "" : "es"}
            {worktree.devServer?.pid ? ` · pid ${worktree.devServer.pid}` : ""}
            {worktree.devServer?.port ? ` · :${worktree.devServer.port}` : ""}
          </span>
        ) : null}
      </div>
      <div className="rowActions" role="cell">
        {canOpenDev ? (
          <button
            className="secondaryButton"
            type="button"
            aria-label={`Open Dev Server for ${worktree.branch ?? "Worktree"}`}
            onClick={() => props.onOpenDev(worktree.worktreeId)}
          >
            <ExternalLink size={15} />
            <span>Open Dev</span>
          </button>
        ) : null}
        {worktree.type === "linked" ? (
          <button
            className="iconButton dangerButton"
            type="button"
            title="Delete Linked Worktree"
            aria-label={`Delete Linked Worktree for ${worktree.branch ?? "detached Worktree"}`}
            disabled={props.isBusy}
            onClick={() => props.onRequestDelete(worktree)}
          >
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>
    </article>
  );
}

// Open Dev is actionable only when a localhost URL or a port is known, matching
// the backend's localhost-only policy.
function isOpenDevActionable(worktree: WorktreeResource): boolean {
  const devServer = worktree.devServer;

  if (!devServer) {
    return false;
  }

  if (devServer.url) {
    return isLocalhostUrl(devServer.url);
  }

  return devServer.port !== undefined;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
