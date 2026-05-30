import { AlertTriangle, CheckCircle2, FolderOpen, X } from "lucide-react";
import { Dispatch, FormEvent, SetStateAction } from "react";

import { useModalFocus } from "@/hooks/use-modal-focus";
import { AppSettingsDraft, SettingsDraft } from "@/types";

export function SettingsSheet(props: {
  appSettingsDraft: AppSettingsDraft;
  setAppSettingsDraft: Dispatch<SetStateAction<AppSettingsDraft | undefined>>;
  repositorySettingsDraft?: SettingsDraft;
  setRepositorySettingsDraft: Dispatch<SetStateAction<SettingsDraft | undefined>>;
  isBusy: boolean;
  isDesktop: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAddExistingWorktree: () => void;
}): JSX.Element {
  const { appSettingsDraft, repositorySettingsDraft, setAppSettingsDraft, setRepositorySettingsDraft } = props;
  const { containerRef, onKeyDown } = useModalFocus<HTMLElement>(props.onClose);

  return (
    <div className="sheetLayer" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={containerRef}
        className="settingsSheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repository-settings-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheetHeader">
          <div>
            <p className="eyebrow">RepoBinder</p>
            <h2 id="repository-settings-title">Settings</h2>
          </div>
          <button className="iconButton" type="button" aria-label="Close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>

        <form className="settingsForm" onSubmit={props.onSubmit}>
          <section className="settingsSection" aria-labelledby="app-settings-title">
            <div className="settingsSectionHeader">
              <p className="eyebrow">App</p>
              <h3 id="app-settings-title">Global Settings</h3>
            </div>

            <label className="toggleRow">
              <input
                type="checkbox"
                checked={appSettingsDraft.remoteModeEnabled}
                disabled={!props.isDesktop}
                onChange={(event) =>
                  setAppSettingsDraft({
                    ...appSettingsDraft,
                    remoteModeEnabled: event.target.checked,
                  })
                }
              />
              <span>Remote Mode</span>
            </label>

            {appSettingsDraft.remoteModeEnabled ? (
              <div className="settingsWarning" role="status">
                <AlertTriangle size={16} />
                <span>Use only on a trusted network.</span>
              </div>
            ) : null}
          </section>

          {repositorySettingsDraft ? (
            <section className="settingsSection" aria-labelledby="repository-settings-section-title">
              <div className="settingsSectionHeader">
                <p className="eyebrow">Repository</p>
                <h3 id="repository-settings-section-title">Worktree Setup</h3>
              </div>

              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={repositorySettingsDraft.setupEnabled}
                  onChange={(event) =>
                    setRepositorySettingsDraft({
                      ...repositorySettingsDraft,
                      setupEnabled: event.target.checked,
                      autoStartDevServer: event.target.checked ? repositorySettingsDraft.autoStartDevServer : false,
                      tailscaleRouting: event.target.checked ? repositorySettingsDraft.tailscaleRouting : false,
                    })
                  }
                />
                <span>Enable Worktree Setup Script</span>
              </label>

              <label className="fieldStack">
                <span>Command</span>
                <input
                  value={repositorySettingsDraft.command}
                  onChange={(event) =>
                    setRepositorySettingsDraft({ ...repositorySettingsDraft, command: event.target.value })
                  }
                  placeholder="scripts/setup-worktree"
                  disabled={!repositorySettingsDraft.setupEnabled}
                />
              </label>

              <label className="fieldStack">
                <span>Default args</span>
                <textarea
                  value={repositorySettingsDraft.defaultArgsText}
                  onChange={(event) =>
                    setRepositorySettingsDraft({ ...repositorySettingsDraft, defaultArgsText: event.target.value })
                  }
                  placeholder="--install"
                  disabled={!repositorySettingsDraft.setupEnabled}
                  rows={5}
                />
              </label>

              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={repositorySettingsDraft.autoStartDevServer}
                  disabled={!repositorySettingsDraft.setupEnabled}
                  onChange={(event) =>
                    setRepositorySettingsDraft({
                      ...repositorySettingsDraft,
                      autoStartDevServer: event.target.checked,
                      tailscaleRouting: event.target.checked ? repositorySettingsDraft.tailscaleRouting : false,
                    })
                  }
                />
                <span>Auto Start Dev Server</span>
              </label>

              <label className="toggleRow">
                <input
                  type="checkbox"
                  checked={repositorySettingsDraft.tailscaleRouting}
                  disabled={!repositorySettingsDraft.setupEnabled || !repositorySettingsDraft.autoStartDevServer}
                  onChange={(event) =>
                    setRepositorySettingsDraft({ ...repositorySettingsDraft, tailscaleRouting: event.target.checked })
                  }
                />
                <span>Tailscale Routing</span>
              </label>
            </section>
          ) : null}

          <div className="sheetActions">
            {props.isDesktop && repositorySettingsDraft ? (
              <button
                className="secondaryButton"
                type="button"
                disabled={props.isBusy}
                onClick={props.onAddExistingWorktree}
              >
                <FolderOpen size={17} />
                <span>Add Existing Worktree</span>
              </button>
            ) : null}
            <button className="secondaryButton" type="button" disabled={props.isBusy} onClick={props.onClose}>
              Cancel
            </button>
            <button className="primaryButton inlineButton" type="submit" disabled={props.isBusy}>
              <CheckCircle2 size={17} />
              <span>Save</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
