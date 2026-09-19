import type { GuildLocale, TaskViewProjection } from "@guild/contracts";
import { ArrowsClockwiseIcon as ArrowsClockwise } from "@phosphor-icons/react/ArrowsClockwise";
import { CaretRightIcon as CaretRight } from "@phosphor-icons/react/CaretRight";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { InfoIcon as Info } from "@phosphor-icons/react/Info";
import { messagesFor } from "./locales.js";
import type { ContinuousFooter } from "./continuous-display.js";

export function ContinuousTaskCard({ task, locale, running, busy, onAction }: {
  readonly task: NonNullable<TaskViewProjection["continuousTask"]>;
  readonly locale: GuildLocale;
  readonly running: boolean;
  readonly busy: boolean;
  readonly onAction: (action: "pause" | "resume" | "stop") => void;
}) {
  const messages = messagesFor(locale);
  const status = task.status === "active"
    ? task.phase === "work" ? messages.continuousWorkPhase : messages.continuousAuditPhase
    : task.status === "paused" ? messages.continuousPaused
      : task.status === "blocked" ? messages.continuousBlocked
        : task.status === "completed" ? messages.continuousCompleted : messages.continuousStop;
  const hasRemaining = task.remaining !== undefined && task.remaining.trim().toUpperCase() !== "NONE";
  const stopReason = task.stopReason === undefined || task.status === "active"
    ? undefined
    : messages.continuousStopReason(task.stopReason);
  return <section className={`guild-continuous-task ${task.status}`} aria-label={messages.continuousMode}>
    <div className="guild-continuous-task-state" aria-live="polite">
      {task.status === "active"
        ? <ArrowsClockwise size={15} className={running ? "guild-spin" : undefined} />
        : task.status === "completed" ? <Check size={15} /> : <Info size={15} />}
      <span>
        <strong>{messages.continuousMode} · {messages.continuousCycle(task.cycle)}</strong>
        <small>{status}</small>
      </span>
    </div>
    <div className="guild-continuous-actions">
      {task.status === "active" ? (
        <button type="button" disabled={busy} onClick={() => onAction("pause")}>{messages.continuousPause}</button>
      ) : task.status === "paused" || task.status === "blocked" ? (
        <button type="button" disabled={busy} onClick={() => onAction("resume")}>{messages.continuousResume}</button>
      ) : null}
      {task.status !== "completed" && task.status !== "stopped" && (
        <button type="button" disabled={busy} onClick={() => onAction("stop")}>{messages.continuousStop}</button>
      )}
    </div>
    <p className="guild-continuous-objective" title={task.objective}>{task.objective}</p>
    {hasRemaining && <p className="guild-continuous-remaining" title={task.remaining}>
      <span>{messages.continuousRemaining}</span>{task.remaining}
    </p>}
    {stopReason !== undefined && <p className="guild-continuous-stop-reason">
      <span>{messages.continuousStopReasonLabel}</span>{stopReason}
    </p>}
    <details className="guild-continuous-progress">
      <summary>{messages.continuousDetails}<CaretRight size={12} /></summary>
      <dl>
        <dt>{messages.continuousObjective}</dt><dd>{task.objective}</dd>
        {task.summary !== undefined && <><dt>{messages.continuousSummary}</dt><dd>{task.summary}</dd></>}
        {task.remaining !== undefined && <><dt>{messages.continuousRemaining}</dt>
          <dd>{hasRemaining ? task.remaining : messages.continuousNoRemaining}</dd></>}
        {stopReason !== undefined && <><dt>{messages.continuousStopReasonLabel}</dt><dd>{stopReason}</dd></>}
      </dl>
    </details>
  </section>;
}

export function ContinuousRoundRecord({ footer, locale }: {
  readonly footer: ContinuousFooter;
  readonly locale: GuildLocale;
}) {
  const messages = messagesFor(locale);
  return <details className="guild-round-record">
    <summary>{messages.continuousRoundRecord}<CaretRight size={12} /></summary>
    <dl>
      <dt>{messages.continuousSummary}</dt><dd>{footer.summary}</dd>
      <dt>{messages.continuousRemaining}</dt><dd>{footer.remaining.toUpperCase() === "NONE"
        ? messages.continuousNoRemaining : footer.remaining}</dd>
      <dt>{messages.continuousReportedVerdict}</dt><dd>{messages.continuousVerdict(footer.verdict)}</dd>
    </dl>
  </details>;
}

export function ContinuousCompletionRecord({ task, locale }: {
  readonly task: NonNullable<TaskViewProjection["continuousTask"]>;
  readonly locale: GuildLocale;
}) {
  const messages = messagesFor(locale);
  return <details className="guild-completion-record">
    <summary><Check size={15} /><span>{messages.historyRecord} · {task.status === "completed"
      ? messages.continuousCompleted : messages.continuousStop}</span><CaretRight size={14} /></summary>
    <dl><dt>{messages.continuousObjective}</dt><dd>{task.objective}</dd>
      {task.summary && <><dt>{messages.continuousSummary}</dt><dd>{task.summary}</dd></>}
      {task.remaining && task.remaining.trim().toUpperCase() !== "NONE" &&
        <><dt>{messages.continuousRemaining}</dt><dd>{task.remaining}</dd></>}
    </dl>
  </details>;
}
