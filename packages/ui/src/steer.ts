/*
 * Keyboard and button rules of Steer (F4) in the composer. Enter keeps queueing the message the way it
 * always has; Option+Enter sends it into the running turn when the runtime can take it.
 */

export type ComposerEnterKey = Readonly<{
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  /** An IME composition is in progress: Enter confirms the candidate, it is not a send. */
  isComposing: boolean;
  keyCode: number;
}>;

export type ComposerEnterAction = "send" | "steer" | "none";

export function composerEnterAction(
  event: ComposerEnterKey,
  context: Readonly<{ steerAvailable: boolean }>,
): ComposerEnterAction {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return "none";
  // Without Steer, Option+Enter is just Enter: the message is sent or queued as usual.
  return event.altKey && context.steerAvailable ? "steer" : "send";
}

export type SteerButtonState = Readonly<{
  /** The button exists only while the running turn can take a message. */
  visible: boolean;
  disabled: boolean;
  /** Why it is disabled, for the tooltip. */
  needsText: boolean;
}>;

export function steerButtonState(input: Readonly<{
  running: boolean;
  steerAvailable: boolean;
  draft: string;
  busy: boolean;
  sendPending: boolean;
  hasAttachments: boolean;
}>): SteerButtonState {
  const visible = input.running && input.steerAvailable;
  const needsText = input.draft.trim().length === 0;
  return Object.freeze({
    visible,
    needsText,
    // An attachment cannot ride along with a mid-turn message.
    disabled: !visible || needsText || input.busy || input.sendPending || input.hasAttachments,
  });
}
