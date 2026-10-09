import { ArrowUUpLeftIcon as ArrowUUpLeft } from "@phosphor-icons/react/ArrowUUpLeft";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/CaretRight";
import { useEffect, useState, type ReactNode } from "react";
import type { GuildMessages } from "./locales.js";
import type { RolledBackSegment } from "./rolled-back.js";

/**
 * What a rewind undid, folded into one dimmed line: the "rewound" tag, the prompt that was taken back
 * and how many turns it covers. The content mounts only while the block is open, and opens by itself when
 * the reader navigates to a search hit inside it.
 */
export function RolledBackBlock({ segment, messages, containsHighlight, initialOpen = false, children }: {
  readonly segment: RolledBackSegment;
  readonly messages: GuildMessages;
  readonly containsHighlight: boolean;
  readonly initialOpen?: boolean;
  readonly children: () => ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen || containsHighlight);
  useEffect(() => {
    if (containsHighlight) setOpen(true);
  }, [containsHighlight]);
  return <details
    className="guild-rolled-back"
    open={open}
    data-sequence={segment.firstSequence}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary
      title={messages.rolledBackExpandHint}
      onClick={(event) => {
        // The state follows the click so the content mounts on the same frame the details opens.
        event.preventDefault();
        setOpen((value) => !value);
      }}
    >
      <ArrowUUpLeft size={14} aria-hidden="true" />
      <span className="guild-rolled-tag">{messages.rolledBackTag}</span>
      {segment.prompt !== undefined && <span className="guild-rolled-prompt">{segment.prompt}</span>}
      <span className="guild-rolled-count">{messages.rolledBackRuns(segment.runCount)}</span>
      <CaretRight size={14} className="guild-rolled-caret" aria-hidden="true" />
    </summary>
    {open && <div className="guild-rolled-body">{children()}</div>}
  </details>;
}
