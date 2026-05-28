import { AlertTriangle, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { WorktreeResource } from "@/types";

export function DeleteWorktreeDialog(props: {
  worktree: WorktreeResource;
  isBusy: boolean;
  onClose: () => void;
  onConfirm: (deleteBranch: boolean) => void;
}): JSX.Element {
  const branchDeleteAvailable = Boolean(props.worktree.branch);
  const defaultDeleteBranch = props.worktree.createdByRepoBinder && branchDeleteAvailable;
  const [deleteBranch, setDeleteBranch] = useState(defaultDeleteBranch);
  const runningProcesses = props.worktree.trackedProcesses.filter((process) => process.status === "running").length;

  useEffect(() => {
    setDeleteBranch(defaultDeleteBranch);
  }, [defaultDeleteBranch, props.worktree.worktreeId]);

  return (
    <div className="dialogLayer" role="presentation" onMouseDown={props.onClose}>
      <section
        className="confirmDialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-worktree-title"
        aria-describedby="delete-worktree-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialogHeader">
          <div className="dangerMark" aria-hidden="true">
            <Trash2 size={19} />
          </div>
          <div>
            <p className="eyebrow">Linked Worktree</p>
            <h2 id="delete-worktree-title">Delete Worktree</h2>
          </div>
          <button className="iconButton" type="button" aria-label="Close" disabled={props.isBusy} onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="dialogBody" id="delete-worktree-description">
          <div className="consequenceItem">
            <span>Remove Worktree Path</span>
            <code>{props.worktree.worktreePath}</code>
            <small>RepoBinder will run git worktree remove. Missing paths are pruned and soft-deleted.</small>
          </div>

          <label className="toggleRow branchDeleteToggle">
            <input
              type="checkbox"
              checked={deleteBranch}
              disabled={props.isBusy || !branchDeleteAvailable}
              onChange={(event) => setDeleteBranch(event.target.checked)}
            />
            <span>Delete Branch safely</span>
          </label>

          <div className="consequenceItem">
            {props.worktree.branch ? <code>{props.worktree.branch}</code> : <code>No Branch</code>}
            <small>Safe delete uses git branch -d, so unmerged work is protected.</small>
          </div>

          {runningProcesses > 0 ? (
            <div className="processWarning">
              <AlertTriangle size={16} />
              <span>
                {runningProcesses} tracked process{runningProcesses === 1 ? "" : "es"} will be stopped first.
              </span>
            </div>
          ) : null}
        </div>

        <div className="dialogActions">
          <button className="secondaryButton" type="button" disabled={props.isBusy} onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="primaryButton inlineButton destructiveAction"
            type="button"
            disabled={props.isBusy}
            onClick={() => props.onConfirm(deleteBranch && branchDeleteAvailable)}
          >
            <Trash2 size={17} />
            <span>Delete</span>
          </button>
        </div>
      </section>
    </div>
  );
}
