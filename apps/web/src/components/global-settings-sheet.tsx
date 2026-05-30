import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Dispatch, FormEvent, SetStateAction } from "react";

import { useModalFocus } from "@/hooks/use-modal-focus";
import { AppSettingsDraft } from "@/types";

export function GlobalSettingsSheet(props: {
  appSettingsDraft: AppSettingsDraft;
  setAppSettingsDraft: Dispatch<SetStateAction<AppSettingsDraft | undefined>>;
  isBusy: boolean;
  isDesktop: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): JSX.Element {
  const { appSettingsDraft, setAppSettingsDraft } = props;
  const { containerRef, onKeyDown } = useModalFocus<HTMLElement>(props.onClose);

  return (
    <div className="sheetLayer" role="presentation" onMouseDown={props.onClose}>
      <section
        ref={containerRef}
        className="settingsSheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-settings-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheetHeader">
          <div>
            <p className="eyebrow">RepoBinder</p>
            <h2 id="global-settings-title">Global Settings</h2>
          </div>
          <button
            className="iconButton"
            type="button"
            aria-label="Close"
            onClick={props.onClose}
          >
            <X size={18} />
          </button>
        </div>

        <form className="settingsForm" onSubmit={props.onSubmit}>
          <section
            className="settingsSection"
            aria-labelledby="app-settings-title"
          >
            <div className="settingsSectionHeader">
              <p className="eyebrow">App</p>
              <h3 id="app-settings-title">Remote Access</h3>
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

          <div className="sheetActions">
            <button
              className="secondaryButton"
              type="button"
              disabled={props.isBusy}
              onClick={props.onClose}
            >
              Cancel
            </button>
            <button
              className="primaryButton inlineButton"
              type="submit"
              disabled={props.isBusy}
            >
              <CheckCircle2 size={17} />
              <span>Save</span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
