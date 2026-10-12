import type { AcpPermissionOptionKind } from "@guild/contracts";
import type { GuildMessages } from "./locales.js";

/*
 * What a permission option's button says. The agent sends its own English text ("Yes", "Yes, allow all
 * edits during this session", "No"); next to a Chinese interface that reads as two languages on one card.
 * The four standard ACP kinds have one Chinese label each and the agent's text stays as the tooltip, so
 * nothing the agent said is lost. A kind the catalog has no label for, and the English interface, keep the
 * agent's text as it is.
 */

export type PermissionOptionView = Readonly<{
  label: string;
  /** The agent's original text, when the label replaced it. */
  title: string | undefined;
}>;

/**
 * An "always" option says in its own words how far it reaches (this session, or a directory and similar
 * commands). The label "allow for this session" is therefore used only when the agent's text speaks of the
 * session; any other "always" option keeps the agent's text, which names the scope the person is agreeing to.
 */
const SESSION_WORDING = /\bsession\b/iu;

export function permissionOptionView(
  messages: Pick<GuildMessages, "permissionOptionByKind">,
  option: Readonly<{ name: string; kind: AcpPermissionOptionKind }>,
): PermissionOptionView {
  const label = messages.permissionOptionByKind(option.kind);
  if (label === undefined || (option.kind === "allow_always" && !SESSION_WORDING.test(option.name))) {
    return Object.freeze({ label: option.name, title: undefined });
  }
  return Object.freeze({ label, title: option.name === label ? undefined : option.name });
}
