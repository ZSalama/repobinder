import { AlertTriangle, GitBranch, Plus, RefreshCw, X } from "lucide-react";
import { FormEvent } from "react";

import { BannerMessage } from "@/components/banner-message";
import { NewWorktreeContext } from "@/types";

export function NewWorktreeSheet(props: {
  displayName: string;
  loading: boolean;
  context?: NewWorktreeContext;
  rows: string[];
  rowErrors: Record<number, string[]>;
  isBusy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateRow: (index: number, value: string) => void;
  onAddRow: () => void;
  onRemoveRow: (index: number) => void;
}): JSX.Element {
  return (
    <div className="sheetLayer" role="presentation" onMouseDown={props.onClose}>
      <section
        className="settingsSheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-worktree-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheetHeader">
          <div>
            <p className="eyebrow">{props.displayName}</p>
            <h2 id="new-worktree-title">New Worktree</h2>
          </div>
          <button className="iconButton" type="button" aria-label="Close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>

        {props.loading ? (
          <div className="sheetLoading" aria-label="Loading New Worktree context">
            <RefreshCw size={20} className="spin" />
          </div>
        ) : (
          <form className="settingsForm" onSubmit={props.onSubmit}>
            {props.context?.detached ? (
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
                  {props.context?.baseBranch ?? "Unknown"}
                </code>
              </div>
            )}

            {props.context?.dirty ? (
              <BannerMessage
                tone="warning"
                text="The Primary Worktree has uncommitted changes. They will not be copied into the new Linked Worktrees."
                icon={<AlertTriangle size={17} />}
              />
            ) : null}

            <div className="branchRowList">
              {props.rows.map((row, index) => (
                <div className="branchRow" key={index}>
                  <label className="fieldStack">
                    <span>{index === 0 ? "Branch name (required)" : `Branch name ${index + 1}`}</span>
                    <div className="branchRowInput">
                      <input
                        value={row}
                        onChange={(event) => props.onUpdateRow(index, event.target.value)}
                        placeholder={index === 0 ? "feature/search" : `auto: ${props.rows[0] || "branch"}-${index + 1}`}
                        aria-invalid={(props.rowErrors[index]?.length ?? 0) > 0}
                      />
                      {index > 0 ? (
                        <button
                          className="iconButton"
                          type="button"
                          aria-label={`Remove Branch row ${index + 1}`}
                          onClick={() => props.onRemoveRow(index)}
                        >
                          <X size={16} />
                        </button>
                      ) : null}
                    </div>
                  </label>
                  {(props.rowErrors[index] ?? []).map((error, errorIndex) => (
                    <p className="rowError" key={errorIndex}>
                      {error}
                    </p>
                  ))}
                </div>
              ))}
            </div>

            {props.rows.length < 5 ? (
              <button className="secondaryButton" type="button" onClick={props.onAddRow}>
                <Plus size={16} />
                <span>Add Worktree row</span>
              </button>
            ) : null}

            <div className="sheetActions">
              <button className="secondaryButton" type="button" disabled={props.isBusy} onClick={props.onClose}>
                Cancel
              </button>
              <button
                className="primaryButton inlineButton"
                type="submit"
                disabled={props.isBusy || props.context?.detached || !props.rows[0]?.trim()}
              >
                <Plus size={17} />
                <span>Create</span>
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
