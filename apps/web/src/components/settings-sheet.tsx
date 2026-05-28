import { CheckCircle2, FolderOpen, X } from "lucide-react";
import { Dispatch, FormEvent, SetStateAction } from "react";

import { SettingsDraft } from "@/types";

export function SettingsSheet(props: {
  settingsDraft: SettingsDraft;
  setSettingsDraft: Dispatch<SetStateAction<SettingsDraft | undefined>>;
  isBusy: boolean;
  isDesktop: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAddExistingWorktree: () => void;
}): JSX.Element {
  const { settingsDraft, setSettingsDraft } = props;

  return (
    <div className="sheetLayer" role="presentation" onMouseDown={props.onClose}>
      <section
        className="settingsSheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repository-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheetHeader">
          <div>
            <p className="eyebrow">Repository</p>
            <h2 id="repository-settings-title">Settings</h2>
          </div>
          <button className="iconButton" type="button" aria-label="Close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>

        <form className="settingsForm" onSubmit={props.onSubmit}>
          <label className="toggleRow">
            <input
              type="checkbox"
              checked={settingsDraft.setupEnabled}
              onChange={(event) =>
                setSettingsDraft({
                  ...settingsDraft,
                  setupEnabled: event.target.checked,
                  autoStartDevServer: event.target.checked ? settingsDraft.autoStartDevServer : false,
                })
              }
            />
            <span>Enable Worktree Setup Script</span>
          </label>

          <label className="fieldStack">
            <span>Command</span>
            <input
              value={settingsDraft.command}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, command: event.target.value })}
              placeholder="scripts/setup-worktree"
              disabled={!settingsDraft.setupEnabled}
            />
          </label>

          <label className="fieldStack">
            <span>Default args</span>
            <textarea
              value={settingsDraft.defaultArgsText}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, defaultArgsText: event.target.value })}
              placeholder="--install"
              disabled={!settingsDraft.setupEnabled}
              rows={5}
            />
          </label>

          <label className="toggleRow">
            <input
              type="checkbox"
              checked={settingsDraft.autoStartDevServer}
              disabled={!settingsDraft.setupEnabled}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, autoStartDevServer: event.target.checked })}
            />
            <span>Auto Start Dev Server</span>
          </label>

          <div className="sheetActions">
            {props.isDesktop ? (
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
