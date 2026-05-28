import { GitBranch } from "lucide-react";

import { Metric, StatusBadge } from "@/components/status-display";
import { devServerTone, formatDevServer, formatSetupStatus, setupTone } from "@/lib/format";
import { RepositoryResource, WorktreeResource } from "@/types";

export function RepositoryDashboard(props: {
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
        <StatusBadge
          tone={props.worktree.type === "primary" ? "neutral" : "info"}
          text={props.worktree.type === "primary" ? "Primary" : "Linked"}
        />
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
