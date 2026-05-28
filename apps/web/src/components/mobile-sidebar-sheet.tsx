import { X } from "lucide-react";

import { SidebarContent } from "@/components/sidebar-content";
import { AppStateResource } from "@/types";

export function MobileSidebarSheet(props: {
  appState: AppStateResource;
  selectedRepositoryId?: string;
  selectedWorktreeId?: string;
  isDesktop: boolean;
  isBusy: boolean;
  onClose: () => void;
  onAddRepository: () => void;
  onSelectRepository: (repositoryId: string, worktreeId?: string) => void;
}): JSX.Element {
  return (
    <div className="sheetLayer" role="presentation" onMouseDown={props.onClose}>
      <aside
        className="mobileSidebarSheet"
        aria-label="Repositories"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="iconButton closeButton" type="button" aria-label="Close" onClick={props.onClose}>
          <X size={18} />
        </button>
        <SidebarContent
          appState={props.appState}
          selectedRepositoryId={props.selectedRepositoryId}
          selectedWorktreeId={props.selectedWorktreeId}
          isDesktop={props.isDesktop}
          isBusy={props.isBusy}
          onAddRepository={props.onAddRepository}
          onSelectRepository={props.onSelectRepository}
        />
      </aside>
    </div>
  );
}
