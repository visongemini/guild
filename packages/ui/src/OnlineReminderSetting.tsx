import type { GuildRendererApi, WorkspaceId, WorkspacePrefsProjection } from "@guild/contracts";
import { useEffect, useRef, useState } from "react";
import type { GuildMessages } from "./locales.js";

export type OnlineReminderSettingProps = Readonly<{
  messages: GuildMessages;
  api: Pick<GuildRendererApi, "getWorkspacePrefs" | "setWorkspacePrefs">;
  /** The workspace of the open conversation; the preference is per workspace, so none open means nothing to change. */
  workspaceId: WorkspaceId | undefined;
  /** Test seam: render with the preference already loaded. */
  initialPrefs?: WorkspacePrefsProjection;
}>;

/**
 * The Privacy tab's switch for the Online-model reminder (PC-PRIV-001), so "Don't remind me again in this
 * workspace" can be taken back. On means Guild asks before the first Online model of a conversation.
 */
export function OnlineReminderSetting({ messages, api, workspaceId, initialPrefs }: OnlineReminderSettingProps) {
  const [prefs, setPrefs] = useState<WorkspacePrefsProjection | undefined>(initialPrefs);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (workspaceId === undefined || initialPrefs !== undefined) return () => { alive.current = false; };
    setPrefs(undefined);
    void api.getWorkspacePrefs({ workspaceId }).then(
      (loaded) => { if (alive.current) setPrefs(loaded); },
      () => { if (alive.current) setFailed(true); },
    );
    return () => { alive.current = false; };
  }, [api, initialPrefs, workspaceId]);

  const reminderOn = prefs !== undefined && !prefs.onlineReminderDismissed;
  const usable = workspaceId !== undefined && prefs !== undefined && !saving;

  async function toggle() {
    if (workspaceId === undefined || prefs === undefined) return;
    setSaving(true);
    setFailed(false);
    try {
      const next = await api.setWorkspacePrefs({ workspaceId, onlineReminderDismissed: reminderOn });
      if (alive.current) setPrefs(next);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  return <section className="guild-settings-block guild-online-reminder-setting" aria-labelledby="guild-privacy-online-heading">
    <h3 className="guild-settings-heading" id="guild-privacy-online-heading">{messages.privacyOnlineHeading}</h3>
    <label className="guild-setting-toggle">
      <span>
        <strong>{messages.privacyOnlineReminder}</strong>
        <small className="guild-setting-help">{messages.privacyOnlineReminderHelp}</small>
      </span>
      <button
        type="button"
        className={`guild-switch ${reminderOn ? "on" : ""}`}
        aria-label={messages.privacyOnlineReminder}
        aria-pressed={reminderOn}
        disabled={!usable}
        onClick={() => void toggle()}
      />
    </label>
    {workspaceId === undefined && <p className="guild-setting-help">{messages.privacyOnlineReminderNoWorkspace}</p>}
    {failed && <p className="guild-setting-help blocked" role="alert">{messages.privacyOnlineReminderFailed}</p>}
  </section>;
}
