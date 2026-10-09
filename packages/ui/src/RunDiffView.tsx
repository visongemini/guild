import type { LoadRunFileDiffResponse, RunId } from "@guild/contracts";
import { XIcon as X } from "@phosphor-icons/react/X";
import { useEffect, useRef, useState } from "react";
import type { GuildMessages } from "./locales.js";
import { parseUnifiedDiff, runCardView, type RunFileView } from "./run-changes.js";
import type { RunCheckpointProjection } from "@guild/contracts";

export type RunDiffViewProps = Readonly<{
  messages: GuildMessages;
  checkpoint: RunCheckpointProjection;
  /** The file whose diff is open; the first file when the view opens without one. */
  path: string | undefined;
  onSelect: (path: string) => void;
  onClose: () => void;
  load: (runId: RunId, path: string) => Promise<LoadRunFileDiffResponse>;
  /** Test seam: render a settled result without a request. */
  initialResult?: DiffResult;
}>;

export type DiffResult =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "ok"; response: Extract<LoadRunFileDiffResponse, { readonly status: "ok" }> }>
  | Readonly<{ state: "unavailable"; reason: "no_checkpoint" | "not_in_run" | "git_failed" }>
  | Readonly<{ state: "failed" }>;

/** What the body of the diff view says for a response, as data so tests need no DOM. */
export function diffResultOf(response: LoadRunFileDiffResponse): DiffResult {
  return response.status === "ok"
    ? Object.freeze({ state: "ok", response })
    : Object.freeze({ state: "unavailable", reason: response.reason });
}

function FileButton({ file, selected, onSelect }: {
  readonly file: RunFileView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return <button
    type="button"
    className={`guild-rundiff-file${selected ? " selected" : ""}`}
    aria-pressed={selected}
    title={file.path}
    onClick={onSelect}
  >
    <span className={`guild-changes-badge ${file.status}`} aria-hidden="true">{file.status}</span>
    <span className="guild-rundiff-name">{file.base}</span>
  </button>;
}

/**
 * The unified diff of one file of a run, loaded on demand and shown at the top of the workbench review
 * tab. It states plainly when a diff is binary, cut at the size limit, empty or not available.
 */
export function RunDiffView({ messages, checkpoint, path, onSelect, onClose, load, initialResult }: RunDiffViewProps) {
  const view = runCardView(checkpoint, false);
  const files = view?.kind === "files" ? view.files : [];
  const selectedPath = path ?? files[0]?.path;
  const [result, setResult] = useState<DiffResult>(initialResult ?? { state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  useEffect(() => {
    if (initialResult !== undefined && attempt === 0) return;
    if (selectedPath === undefined) return;
    const current = ++requestId.current;
    setResult({ state: "loading" });
    load(checkpoint.runId, selectedPath).then(
      (response) => { if (requestId.current === current) setResult(diffResultOf(response)); },
      () => { if (requestId.current === current) setResult({ state: "failed" }); },
    );
    return () => { requestId.current += 1; };
  }, [checkpoint.runId, selectedPath, attempt, load, initialResult]);

  return <section className="guild-rundiff" aria-label={messages.runDiffHeading(checkpoint.ordinal)}>
    <div className="guild-rundiff-head">
      <strong>{messages.runDiffHeading(checkpoint.ordinal)}</strong>
      <button type="button" className="guild-icon-button" aria-label={messages.runDiffClose} title={messages.runDiffClose} onClick={onClose}><X size={14} /></button>
    </div>
    {files.length > 1 && <div className="guild-rundiff-files" role="group" aria-label={messages.runDiffFiles}>
      {files.map((file) => <FileButton key={file.path} file={file} selected={file.path === selectedPath} onSelect={() => onSelect(file.path)} />)}
    </div>}
    {selectedPath !== undefined && <code className="guild-rundiff-path" title={selectedPath}>{selectedPath}</code>}
    <div className="guild-rundiff-body" aria-live="polite">
      <DiffBody result={result} messages={messages} onRetry={() => setAttempt((value) => value + 1)} />
    </div>
  </section>;
}

function DiffBody({ result, messages, onRetry }: {
  readonly result: DiffResult;
  readonly messages: GuildMessages;
  readonly onRetry: () => void;
}) {
  if (result.state === "loading") return <p className="guild-rundiff-note">{messages.runDiffLoading}</p>;
  if (result.state === "failed") {
    return <p className="guild-rundiff-note error">{messages.runDiffFailed}<button type="button" className="guild-ghost-button" onClick={onRetry}>{messages.runDiffRetry}</button></p>;
  }
  if (result.state === "unavailable") return <p className="guild-rundiff-note">{messages.runDiffUnavailable(result.reason)}</p>;
  const { response } = result;
  if (response.binary) return <p className="guild-rundiff-note">{messages.runDiffBinary}</p>;
  const lines = parseUnifiedDiff(response.diff);
  if (lines.length === 0) return <p className="guild-rundiff-note">{messages.runDiffEmpty}</p>;
  return <>
    <pre className="guild-rundiff-code" tabIndex={0}>
      {lines.map((line, index) => <span key={index} className={`line ${line.kind}`}>{line.text.length === 0 ? " " : line.text}</span>)}
    </pre>
    {response.truncated && <p className="guild-rundiff-note">{messages.runDiffTruncated}</p>}
  </>;
}
