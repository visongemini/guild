import type { GuildLocale, RunPhaseProjection } from "@guild/contracts";
import { useEffect, useState } from "react";
import { messagesFor } from "./locales.js";
import {
  advanceRunPhaseHistory,
  describeRunPhase,
  describeRunPhaseTrail,
  startRunPhaseHistory,
  type RunPhaseHistory,
} from "./run-phase-display.js";

export type RunPhaseLineProps = Readonly<{
  projection: RunPhaseProjection;
  locale: GuildLocale;
  /** Clock seed for the first render (tests); the 1 Hz timer takes over once mounted. */
  initialNowMs?: number;
}>;

/**
 * What the running turn is waiting for: a pulsing dot, the current phase with the time spent in
 * it, a faint trail of the phases that already ended, and the whole turn on the right. Shares the
 * `.guild-run-status` grid with the legacy status line. The single 1 Hz interval lives only while
 * the line is mounted, and the live region announces the label alone, never the ticking time.
 */
export function RunPhaseLine({ projection, locale, initialNowMs }: RunPhaseLineProps) {
  const messages = messagesFor(locale);
  const [nowMs, setNowMs] = useState(() => initialNowMs ?? Date.now());
  // Derived state, updated while rendering: the history follows the projection without an extra pass.
  const [history, setHistory] = useState<RunPhaseHistory>(() => startRunPhaseHistory(projection));
  const current = advanceRunPhaseHistory(history, projection);
  if (current !== history) setHistory(current);
  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [projection.phase, projection.turnStartedAtMs, projection.phaseStartedAtMs]);
  const display = describeRunPhase(projection, nowMs, messages);
  const trail = describeRunPhaseTrail(current, messages);
  return <div className={`guild-run-status guild-run-phase ${display.phase}${display.softNotice ? " notice" : ""}`}>
    <span className="guild-run-pip" aria-hidden="true" />
    <span className="guild-run-now">
      <span className="guild-run-label" role="status" aria-live="polite">{display.label}</span>
      {display.showPhaseSeconds && <span className="guild-run-elapsed" aria-hidden="true">{messages.runDuration(display.phaseSeconds)}</span>}
      {trail.length > 0 && <span className="guild-run-trail" aria-hidden="true">
        {trail.map((entry, index) => <span key={entry.key}>{index > 0 && <i />}{entry.text}</span>)}
      </span>}
    </span>
    <time aria-hidden="true">{messages.runPhaseTime(undefined, messages.runDuration(display.totalSeconds))}</time>
  </div>;
}
