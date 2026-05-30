import {
  ChevronRight,
  FolderOpen,
  GitBranch,
  Plus,
  Settings,
} from "lucide-react";

import { StatusDot } from "@/components/status-display";
import { AppStateResource, RepositoryResource } from "@/types";

export function SidebarContent(props: {
  appState: AppStateResource;
  selectedRepositoryId?: string;
  selectedWorktreeId?: string;
  isDesktop: boolean;
  isBusy: boolean;
  onAddRepository: () => void;
  onOpenGlobalSettings: () => void;
  onSelectRepository: (repositoryId: string, worktreeId?: string) => void;
}): JSX.Element {
  return (
    <div className="sidebarContent">
      <div className="sidebarBrand">
        <div className="brandMark" aria-hidden="true">
          <GitBranch size={20} />
        </div>
        <div className="sidebarBrandText">
          <h2>RepoBinder</h2>
          <p>{props.appState.repositories.length} Repositories</p>
        </div>
        <button
          className="iconButton brandSettingsButton"
          type="button"
          aria-label="Global settings"
          disabled={props.isBusy}
          onClick={props.onOpenGlobalSettings}
        >
          <Settings size={18} />
        </button>
      </div>

      {props.isDesktop ? (
        <button
          className="primaryButton"
          type="button"
          disabled={props.isBusy}
          onClick={props.onAddRepository}
        >
          <Plus size={17} />
          <span>Add Repository</span>
        </button>
      ) : null}

      <nav className="repositoryNav" aria-label="Repository groups">
        {props.appState.repositories.length > 0 ? (
          <p className="navLabel">Repositories</p>
        ) : null}
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
  const isSelectedRepository =
    props.repository.repositoryId === props.selectedRepositoryId;

  return (
    <div className="repositoryGroup">
      <button
        className={`repositoryButton ${isSelectedRepository ? "selected" : ""}`}
        type="button"
        disabled={props.disabled}
        aria-current={isSelectedRepository ? "page" : undefined}
        aria-label={`Select Repository ${props.repository.displayName}`}
        onClick={() => props.onSelect(props.repository.repositoryId)}
      >
        <ChevronRight
          size={15}
          className={isSelectedRepository ? "chevronOpen" : undefined}
          aria-hidden="true"
        />
        <span>{props.repository.displayName}</span>
        <small>{props.repository.worktrees.length}</small>
      </button>

      <div className="worktreeNavList">
        {props.repository.worktrees.map((worktree) => {
          const isSelectedWorktree =
            worktree.worktreeId === props.selectedWorktreeId;

          return (
            <button
              className={`worktreeNavButton ${isSelectedWorktree ? "selected" : ""}`}
              type="button"
              key={worktree.worktreeId}
              disabled={props.disabled}
              aria-current={isSelectedWorktree ? "true" : undefined}
              aria-label={`Select ${worktree.type === "primary" ? "Primary" : "Linked"} Worktree ${
                worktree.branch ?? "Detached HEAD"
              }`}
              onClick={() =>
                props.onSelect(
                  props.repository.repositoryId,
                  worktree.worktreeId,
                )
              }
            >
              <StatusDot
                status={
                  worktree.availability === "available" ? "success" : "warning"
                }
              />
              <span>{worktree.branch ?? "Detached HEAD"}</span>
              <small>
                {worktree.type === "primary" ? "Primary" : "Linked"}
              </small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
