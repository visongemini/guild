import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { GuildMessages } from "./locales.js";

export type OnlineReminderDialogProps = Readonly<{
  messages: GuildMessages;
  /** The model source's label, for example the vendor's name. Present when the Online reminder is due. */
  vendorLabel?: string;
  /**
   * The model being switched to, present when the task has a Claude session that this switch moves onto the
   * model router for good (D-061). The dialog then also says that, in the same box, and may carry both messages.
   */
  routedModelName?: string;
  /** Cancel, Escape and a click outside all end here; nothing was switched. */
  onCancel: () => void;
  /** Switch was chosen; the flag is the "Don't remind me again in this workspace" checkbox. */
  onSwitch: (dontRemindAgain: boolean) => void;
  /** The app's modal keyboard handling (Escape and Tab containment). */
  onDialogKeyDown: (event: ReactKeyboardEvent<HTMLElement>, onEscape: () => void) => void;
  /** Test seam: render the dialog with the box already ticked. */
  initialDontRemind?: boolean;
}>;

/**
 * Says plainly what an Online model receives (CLAUDE.md, memory, the conversation, and page text or
 * screenshots from the browser pane) and asks before switching, and, when the switch leaves the Claude
 * subscription for good, says that first. Cancel is the default action.
 */
export function OnlineReminderDialog({
  messages,
  vendorLabel,
  routedModelName,
  onCancel,
  onSwitch,
  onDialogKeyDown,
  initialDontRemind = false,
}: OnlineReminderDialogProps) {
  const [dontRemind, setDontRemind] = useState(initialDontRemind);
  const titleId = useId();
  const bodyId = useId();
  return <div className="guild-dialog-backdrop" role="presentation" onPointerDown={onCancel}>
    <div
      className="guild-dialog guild-online-reminder"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => onDialogKeyDown(event, onCancel)}
    >
      <div className="guild-dialog-header"><strong id={titleId}>{routedModelName !== undefined
        ? messages.routedSwitchTitle
        : messages.onlineReminderTitle(vendorLabel ?? "")}</strong></div>
      <div className="guild-dialog-body guild-online-reminder-body" id={bodyId}>
        {routedModelName !== undefined && <p>{messages.routedSwitchBody(routedModelName)}</p>}
        {vendorLabel !== undefined && <>
          <p>{messages.onlineReminderLead(vendorLabel)}</p>
          <ul>
            <li>{messages.onlineReminderItemClaudeMd}</li>
            <li>{messages.onlineReminderItemMemory}</li>
            <li>{messages.onlineReminderItemConversation}</li>
            <li>{messages.onlineReminderItemBrowser}</li>
          </ul>
          <label className="guild-rewind-optin">
            <input type="checkbox" checked={dontRemind} onChange={(event) => setDontRemind(event.currentTarget.checked)} />
            <span><strong>{messages.onlineReminderDontRemind}</strong></span>
          </label>
        </>}
      </div>
      <div className="guild-dialog-footer">
        <button autoFocus type="button" onClick={onCancel}>{messages.cancel}</button>
        <button type="button" className="primary" onClick={() => onSwitch(dontRemind)}>{routedModelName !== undefined
          ? messages.routedSwitchConfirm
          : messages.onlineReminderSwitch}</button>
      </div>
    </div>
  </div>;
}
