import { AlertTriangle, CheckCircle2, History, Info, X } from "lucide-react";

import { StatusBadge } from "@/components/status-display";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { OperationRecord, OperationSeverity } from "@/types";

export function ActivitySheet(props: { operations: OperationRecord[]; onClose: () => void }): JSX.Element {
  const { containerRef, onKeyDown } = useModalFocus<HTMLElement>(props.onClose);

  return (
    <div className="sheetLayer" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={containerRef}
        className="activitySheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheetHeader">
          <div>
            <p className="eyebrow">Recent Operations</p>
            <h2 id="activity-title">Activity</h2>
          </div>
          <button className="iconButton" type="button" aria-label="Close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="activityList">
          {props.operations.length > 0 ? (
            props.operations.map((operation) => <ActivityItem key={operation.operationId} operation={operation} />)
          ) : (
            <div className="emptyActivity">
              <History size={28} />
              <span>No Operation Records yet</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ActivityItem(props: { operation: OperationRecord }): JSX.Element {
  const { operation } = props;
  const tone = operationTone(operation.severity);
  const details = operation.details ? JSON.stringify(operation.details, null, 2) : undefined;

  return (
    <article className={`activityItem ${tone}`}>
      <div className="activityIcon" aria-hidden="true">
        {operationIcon(operation.severity)}
      </div>
      <div className="activityBody">
        <div className="activityHeader">
          <div className="activitySummary">
            <strong>{operation.summary}</strong>
            <span>{formatOperationTime(operation.completedAt ?? operation.updatedAt ?? operation.createdAt)}</span>
          </div>
          <StatusBadge tone={tone} text={formatStatus(operation.status)} />
        </div>

        <div className="activityMeta">
          <code>{operation.type}</code>
          {operation.repositoryId ? <span>Repository {shortId(operation.repositoryId)}</span> : null}
          {operation.worktreeId ? <span>Worktree {shortId(operation.worktreeId)}</span> : null}
        </div>

        <details className="activityDetails">
          <summary>Details</summary>
          <dl className="detailsGrid">
            <div>
              <dt>Operation ID</dt>
              <dd>
                <code>{operation.operationId}</code>
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatOperationTime(operation.createdAt)}</dd>
            </div>
            {operation.completedAt ? (
              <div>
                <dt>Completed</dt>
                <dd>{formatOperationTime(operation.completedAt)}</dd>
              </div>
            ) : null}
          </dl>
          {details ? <pre className="detailsJson">{details}</pre> : <p className="detailsEmpty">No details recorded.</p>}
        </details>
      </div>
    </article>
  );
}

function operationTone(severity: OperationSeverity): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (severity) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "danger";
    case "info":
      return "info";
  }
}

function operationIcon(severity: OperationSeverity): JSX.Element {
  switch (severity) {
    case "success":
      return <CheckCircle2 size={18} />;
    case "warning":
    case "error":
      return <AlertTriangle size={18} />;
    case "info":
      return <Info size={18} />;
  }
}

function formatStatus(status: OperationRecord["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "success":
      return "Success";
    case "warning":
      return "Warning";
    case "failed":
      return "Failed";
  }
}

function formatOperationTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function shortId(value: string): string {
  const index = value.indexOf("_");
  const suffix = index >= 0 ? value.slice(index + 1) : value;
  return suffix.slice(0, 8);
}
