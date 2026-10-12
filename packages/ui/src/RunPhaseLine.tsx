import type { GuildEngine, GuildLocale, RunPhaseProjection } from "@guild/contracts";
import { useEffect, useState } from "react";
import { messagesFor } from "./locales.js";
import {
  advanceRunPhaseHistory,
  describeRunPhase,
  describeRunPhaseTrail,
  startRunPhaseHistory,
  type RunPhaseDisplay,
  type RunPhaseHistory,
  type RunPhaseTrailDisplay,
} from "./run-phase-display.js";

export type RunPhaseLineProps = Readonly<{
  projection: RunPhaseProjection;
  locale: GuildLocale;
  /** Engine of the task; the phase labels that name the runtime follow it. Grok when absent. */
  engine?: GuildEngine;
  /** Clock seed for the first render (tests); the 1 Hz timer takes over once mounted. */
  initialNowMs?: number;
}>;

/**
 * What the running turn is waiting for: a pulsing dot, a faint trail of the phases that already
 * ended (oldest first), the current phase with the time spent in it, and the whole turn on the right. Shares the
 * `.guild-run-status` grid with the legacy status line. The single 1 Hz interval lives only while
 * the line is mounted, and the live region announces the label alone, never the ticking time.
 */
export function RunPhaseLine({ projection, locale, engine = "grok", initialNowMs }: RunPhaseLineProps) {
  const messages = messagesFor(locale, engine);
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
  return <RunPhaseLineView display={display} trail={trail} totalText={messages.runPhaseTime(undefined, messages.runDuration(display.totalSeconds))} elapsedText={display.showPhaseSeconds ? messages.runDuration(display.phaseSeconds) : undefined} />;
}

/** The markup of the line, apart from the clock and the history: trail first (oldest to newest), then the phase running now. Exported for tests. */
export function RunPhaseLineView({ display, trail, totalText, elapsedText }: Readonly<{
  display: RunPhaseDisplay;
  trail: readonly RunPhaseTrailDisplay[];
  totalText: string;
  elapsedText: string | undefined;
}>) {
  return <div className={`guild-run-status guild-run-phase ${display.phase}${display.softNotice ? " notice" : ""}`}>
    <span className="guild-run-pip" aria-hidden="true" />
    <span className="guild-run-now">
      {trail.length > 0 && <span className="guild-run-trail" aria-hidden="true">
        {trail.map((entry) => <span key={entry.key}>{entry.text}<i /></span>)}
      </span>}
      <span className="guild-run-current">
        <span className="guild-run-label" role="status" aria-live="polite" title={display.toolTitle}>{display.label}</span>
        {elapsedText !== undefined && <span className="guild-run-elapsed" aria-hidden="true">{elapsedText}</span>}
      </span>
    </span>
    <time aria-hidden="true">{totalText}</time>
  </div>;
}
