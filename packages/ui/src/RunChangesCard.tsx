import type { RewindAvailabilityProjection, RunCheckpointProjection, RunId } from "@guild/contracts";
import { ArrowUUpLeftIcon as ArrowUUpLeft } from "@phosphor-icons/react/ArrowUUpLeft";
import { FileTextIcon as FileText } from "@phosphor-icons/react/FileText";
import { memo, useState } from "react";
import type { GuildMessages } from "./locales.js";
import { rewindDisabledReason, runCardView, type RunFileView } from "./run-changes.js";

/** More rows than this fold behind "show all"; a run can touch hundreds of files. */
export const RUN_CARD_VISIBLE_FILES = 8;

export type RunCardData = Readonly<{
  checkpoint: RunCheckpointProjection;
  rewind: RewindAvailabilityProjection | undefined;
}>;

export type RunChangesCardProps = Readonly<{
  data: RunCardData;
  messages: GuildMessages;
  /** Opens the workbench diff for the run, on one file when a path is given. */
  onViewDiff: (runId: RunId, path?: string) => void;
  /** Opens the rewind dialog; the button is the dialog's return-focus target. */
  onRewind: (runId: RunId, trigger: HTMLElement) => void;
  /** Test seam: start with the long list unfolded. */
  initialExpanded?: boolean;
}>;

function FileRow({ file, messages, onOpen }: {
  readonly file: RunFileView;
  readonly messages: GuildMessages;
  readonly onOpen: () => void;
}) {
  const statusLabel = messages.changesStatusLabel(file.status);
  return <li className="guild-changes-row">
    <button
      type="button"
      className="guild-changes-file"
      title={file.oldPath === undefined ? file.path : `${messages.changesRenamedFrom(file.oldPath)}\n${file.path}`}
      aria-label={`${statusLabel}, ${messages.changesOpenFileDiff(file.path)}`}
      onClick={onOpen}
    >
      <span className={`guild-changes-badge ${file.status}`} aria-hidden="true">{file.status}</span>
      <span className="guild-changes-path">
        {file.dir.length > 0 && <span className="guild-changes-dir">{file.dir}</span>}{file.base}
      </span>
      <span className="guild-changes-counts">
        {file.binary
          ? <span className="guild-changes-binary">{messages.changesBinary}</span>
          : <><span className="a">+{file.adds}</span><span className="d">{"−"}{file.dels}</span></>}
      </span>
    </button>
  </li>;
}

/**
 * The card under a finished turn: what the turn changed on disk, with the two things worth doing next,
 * looking at the diff and going back. It renders nothing for a turn without file changes, one faint
 * line when changes could not be tracked, and a quiet placeholder while the end snapshot is taken.
 */
export const RunChangesCard = memo(function RunChangesCard({ data, messages, onViewDiff, onRewind, initialExpanded = false }: RunChangesCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const view = runCardView(data.checkpoint, false);
  if (view === undefined) return null;
  if (view.kind === "capturing") {
    return <p className="guild-changes-note" role="status">{messages.changesCapturing}</p>;
  }
  if (view.kind === "unavailable") {
    return <p className="guild-changes-note unavailable">{messages.changesUnavailable(view.reason)}</p>;
  }
  const disabledReason = rewindDisabledReason(data.rewind);
  const shown = expanded ? view.files : view.files.slice(0, RUN_CARD_VISIBLE_FILES);
  const folded = view.files.length - RUN_CARD_VISIBLE_FILES;
  const rewindLabel = messages.changesRewind;
  return <section
    className={`guild-changes${view.rolledBack ? " rolled-back" : ""}`}
    data-run-card={view.runId}
    aria-label={messages.changesTitle(view.filesChanged)}
  >
    <div className="guild-changes-head">
      <FileText size={16} aria-hidden="true" />
      <b>{messages.changesTitle(view.filesChanged)}</b>
      <span className="guild-changes-delta"><span className="a">+{view.adds}</span> <span className="d">{"−"}{view.dels}</span></span>
      {view.rolledBack && <span className="guild-changes-tag">{messages.changesRolledBack}</span>}
      <span className="guild-changes-actions">
        <button type="button" className="guild-ghost-button" onClick={() => onViewDiff(view.runId)}>{messages.changesViewDiff}</button>
        {!view.rolledBack && (
          <button
            type="button"
            className="guild-ghost-button guild-changes-rewind"
            aria-disabled={disabledReason !== undefined || undefined}
            aria-label={disabledReason === undefined ? undefined : `${rewindLabel} (${messages.rewindDisabledReason(disabledReason)})`}
            title={disabledReason === undefined ? undefined : messages.rewindDisabledReason(disabledReason)}
            onClick={(event) => {
              if (disabledReason === undefined) onRewind(view.runId, event.currentTarget);
            }}
          ><ArrowUUpLeft size={14} aria-hidden="true" />{rewindLabel}</button>
        )}
      </span>
    </div>
    {shown.length > 0 && <ul className="guild-changes-files">
      {shown.map((file) => <FileRow key={file.path} file={file} messages={messages} onOpen={() => onViewDiff(view.runId, file.path)} />)}
    </ul>}
    {(folded > 0 || view.filesTruncated) && <div className="guild-changes-foot">
      {folded > 0 && (
        <button type="button" className="guild-ghost-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? messages.changesShowLess : messages.changesShowAll(view.files.length)}
        </button>
      )}
      {view.filesTruncated && <span className="guild-changes-truncated">{messages.changesTruncated(view.files.length, view.filesChanged)}</span>}
    </div>}
  </section>;
});
