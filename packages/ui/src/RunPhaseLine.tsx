import type { GuildLocale, RunPhaseProjection } from "@guild/contracts";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { useEffect, useState } from "react";
import { messagesFor } from "./locales.js";
import { describeRunPhase } from "./run-phase-display.js";

export type RunPhaseLineProps = Readonly<{
  projection: RunPhaseProjection;
  locale: GuildLocale;
  /** Clock seed for the first render (tests); the 1 Hz timer takes over once mounted. */
  initialNowMs?: number;
}>;

/**
 * What the running turn is waiting for, with the time spent in this phase and in the whole turn.
 * Shares the `.guild-run-status` look with the legacy status line. The single 1 Hz interval lives
 * only while the line is mounted.
 */
export function RunPhaseLine({ projection, locale, initialNowMs }: RunPhaseLineProps) {
  const messages = messagesFor(locale);
  const [nowMs, setNowMs] = useState(() => initialNowMs ?? Date.now());
  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [projection.phase, projection.turnStartedAtMs, projection.phaseStartedAtMs]);
  const display = describeRunPhase(projection, nowMs, messages);
  return <div className={`guild-run-status guild-run-phase ${display.phase}${display.softNotice ? " notice" : ""}`}>
    <SpinnerGap size={14} className="guild-spin" aria-hidden="true" />
    <span role="status" aria-live="polite">{display.label}</span>
    <time aria-hidden="true">{display.timeText}</time>
  </div>;
}
