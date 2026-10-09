import assert from "node:assert/strict";
import test from "node:test";
import {
  GUILD_RUN_PHASES,
  GUILD_RUN_PHASE_SENT_NOTICE_MS,
  type GuildRunPhase,
  type RunPhaseProjection,
} from "@guild/contracts";
import { messagesFor } from "./locales.js";
import { RUN_PHASE_SENT_NOTICE_MS, describeRunPhase } from "./run-phase-display.js";

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");
const TURN_START = 1_000_000;

function projection(phase: GuildRunPhase, extra: Partial<RunPhaseProjection> = {}): RunPhaseProjection {
  return Object.freeze({
    phase,
    turnStartedAtMs: TURN_START,
    phaseStartedAtMs: TURN_START + 5_000,
    ...extra,
  });
}

test("the notice threshold equals the contract constant", () => {
  assert.equal(RUN_PHASE_SENT_NOTICE_MS, GUILD_RUN_PHASE_SENT_NOTICE_MS);
});

test("every phase has a label in both locales", () => {
  const expected: Readonly<Record<GuildRunPhase, readonly [string, string]>> = {
    starting_runtime: ["Starting Grok", "\u6b63\u5728\u542f\u52a8 Grok"],
    opening_session: ["Opening session", "\u6b63\u5728\u6253\u5f00\u4f1a\u8bdd"],
    prompt_sent: ["Sent", "\u5df2\u53d1\u9001"],
    queued: ["Queued", "\u6392\u961f\u4e2d"],
    running_hooks: ["Running hooks", "\u6b63\u5728\u8fd0\u884c\u94a9\u5b50"],
    waiting_for_model: ["Waiting for model", "\u7b49\u5f85\u6a21\u578b\u54cd\u5e94"],
    thinking: ["Thinking", "\u601d\u8003\u4e2d"],
    preparing_tool: ["Preparing tool", "\u6b63\u5728\u51c6\u5907\u5de5\u5177"],
    waiting_for_permission: ["Waiting for your permission", "\u7b49\u5f85\u4f60\u7684\u6388\u6743"],
    running_tool: ["Running tool", "\u6b63\u5728\u8fd0\u884c\u5de5\u5177"],
    retrying: ["Retrying", "\u6b63\u5728\u91cd\u8bd5"],
    responding: ["Responding", "\u6b63\u5728\u56de\u7b54"],
  };
  assert.deepEqual([...GUILD_RUN_PHASES].sort(), Object.keys(expected).sort());
  for (const phase of GUILD_RUN_PHASES) {
    const now = TURN_START + 6_000;
    assert.equal(describeRunPhase(projection(phase), now, EN).label, expected[phase][0], `en ${phase}`);
    assert.equal(describeRunPhase(projection(phase), now, ZH).label, expected[phase][1], `zh ${phase}`);
  }
});

test("counts and the tool name are substituted when present", () => {
  const now = TURN_START + 6_000;
  const label = (messages: typeof EN, input: RunPhaseProjection) => describeRunPhase(input, now, messages).label;
  assert.equal(label(EN, projection("queued", { queuePosition: 2 })), "Queued #2");
  assert.equal(label(ZH, projection("queued", { queuePosition: 2 })), "\u6392\u961f\u4e2d #2");
  assert.equal(label(EN, projection("running_hooks", { hookCount: 3 })), "Running hooks (3)");
  assert.equal(label(ZH, projection("running_hooks", { hookCount: 3 })), "\u6b63\u5728\u8fd0\u884c\u94a9\u5b50\uff083\uff09");
  assert.equal(label(EN, projection("preparing_tool", { toolName: "Bash" })), "Preparing tool Bash");
  assert.equal(label(ZH, projection("preparing_tool", { toolName: "Bash" })), "\u6b63\u5728\u51c6\u5907\u5de5\u5177 Bash");
  assert.equal(label(EN, projection("running_tool", { toolName: "Bash" })), "Running Bash");
  assert.equal(label(ZH, projection("running_tool", { toolName: "Bash" })), "\u6b63\u5728\u8fd0\u884c Bash");
  assert.equal(label(EN, projection("retrying", { attempt: 2, maxRetries: 5 })), "Retrying 2/5");
  assert.equal(label(ZH, projection("retrying", { attempt: 2, maxRetries: 5 })), "\u6b63\u5728\u91cd\u8bd5 2/5");
  // A half-known retry shows the bare label rather than a guessed ratio.
  assert.equal(label(EN, projection("retrying", { attempt: 2 })), "Retrying");
});

test("opening the session appends the MCP count only when both numbers are known", () => {
  const now = TURN_START + 6_000;
  const opening = (extra: Partial<RunPhaseProjection>, messages = EN) =>
    describeRunPhase(projection("opening_session", extra), now, messages).label;
  assert.equal(opening({ mcpConnected: 3, mcpTotal: 7 }), "Opening session \u00b7 MCP 3/7");
  assert.equal(opening({ mcpConnected: 0, mcpTotal: 7 }), "Opening session \u00b7 MCP 0/7");
  assert.equal(opening({ mcpConnected: 3, mcpTotal: 7 }, ZH), "\u6b63\u5728\u6253\u5f00\u4f1a\u8bdd \u00b7 MCP 3/7");
  assert.equal(opening({ mcpConnected: 3 }), "Opening session");
  assert.equal(opening({ mcpTotal: 7 }), "Opening session");
  assert.equal(opening({}), "Opening session");
});

test("the Sent notice appears exactly at ten seconds and only for a sent prompt", () => {
  const sent = projection("prompt_sent", { turnStartedAtMs: TURN_START, phaseStartedAtMs: TURN_START });
  const before = describeRunPhase(sent, TURN_START + 9_999, EN);
  const at = describeRunPhase(sent, TURN_START + 10_000, EN);
  assert.equal(before.softNotice, false);
  assert.equal(before.label, "Sent");
  assert.equal(at.softNotice, true);
  assert.equal(at.label, "Sent \u00b7 Grok has not picked it up yet");
  assert.equal(describeRunPhase(sent, TURN_START + 10_000, ZH).label, "\u5df2\u53d1\u9001 \u00b7 Grok \u5c1a\u672a\u63a5\u624b");
  assert.equal(describeRunPhase(sent, TURN_START + 60_000, EN).softNotice, true);
  // The notice measures the phase, not the turn.
  const lateSend = projection("prompt_sent", { phaseStartedAtMs: TURN_START + 30_000 });
  assert.equal(describeRunPhase(lateSend, TURN_START + 39_999, EN).softNotice, false);
  assert.equal(describeRunPhase(lateSend, TURN_START + 40_000, EN).softNotice, true);
  for (const phase of GUILD_RUN_PHASES.filter((candidate) => candidate !== "prompt_sent")) {
    assert.equal(
      describeRunPhase(projection(phase, { phaseStartedAtMs: TURN_START }), TURN_START + 120_000, EN).softNotice,
      false,
      phase,
    );
  }
});

test("durations read 12s below a minute, then 1m 05s, in both locales", () => {
  assert.equal(EN.runDuration(0), "0s");
  assert.equal(EN.runDuration(12), "12s");
  assert.equal(EN.runDuration(59), "59s");
  assert.equal(EN.runDuration(60), "1m 00s");
  assert.equal(EN.runDuration(61), "1m 01s");
  assert.equal(EN.runDuration(65), "1m 05s");
  assert.equal(EN.runDuration(3_599), "59m 59s");
  assert.equal(EN.runDuration(3_600), "1h 00m 00s");
  assert.equal(ZH.runDuration(12), "12 \u79d2");
  assert.equal(ZH.runDuration(59), "59 \u79d2");
  assert.equal(ZH.runDuration(60), "1 \u5206 00 \u79d2");
  assert.equal(ZH.runDuration(65), "1 \u5206 05 \u79d2");
  assert.equal(ZH.runDuration(3_600), "1 \u5c0f\u65f6 00 \u5206 00 \u79d2");
});

test("the time text shows the phase and the total, and drops a phase part that adds nothing", () => {
  const thinking = projection("thinking", { phaseStartedAtMs: TURN_START + 12_000 });
  const display = describeRunPhase(thinking, TURN_START + 35_000, EN);
  assert.equal(display.totalSeconds, 35);
  assert.equal(display.phaseSeconds, 23);
  assert.equal(display.showPhaseSeconds, true);
  assert.equal(display.timeText, "23s \u00b7 total 35s");
  assert.equal(describeRunPhase(thinking, TURN_START + 35_000, ZH).timeText, "23 \u79d2 \u00b7 \u5171 35 \u79d2");

  const longer = describeRunPhase(
    projection("thinking", { phaseStartedAtMs: TURN_START + 5_000 }),
    TURN_START + 65_000,
    EN,
  );
  assert.equal(longer.timeText, "1m 00s \u00b7 total 1m 05s");

  // The phase began with the turn: only the total is shown.
  const sameStart = describeRunPhase(
    projection("starting_runtime", { phaseStartedAtMs: TURN_START }),
    TURN_START + 12_000,
    EN,
  );
  assert.equal(sameStart.showPhaseSeconds, false);
  assert.equal(sameStart.timeText, "total 12s");
  assert.equal(
    describeRunPhase(projection("starting_runtime", { phaseStartedAtMs: TURN_START }), TURN_START + 12_000, ZH).timeText,
    "\u5171 12 \u79d2",
  );

  // A phase that started within the same second as the turn reads the same value: omit it.
  const sameSecond = describeRunPhase(
    projection("thinking", { phaseStartedAtMs: TURN_START + 400 }),
    TURN_START + 12_400,
    EN,
  );
  assert.equal(sameSecond.phaseSeconds, sameSecond.totalSeconds);
  assert.equal(sameSecond.showPhaseSeconds, false);
  assert.equal(sameSecond.timeText, "total 12s");
});

test("seconds floor at the boundary and never go negative", () => {
  const input = projection("waiting_for_model", { phaseStartedAtMs: TURN_START + 1_000 });
  assert.equal(describeRunPhase(input, TURN_START + 59_999, EN).totalSeconds, 59);
  assert.equal(describeRunPhase(input, TURN_START + 60_000, EN).totalSeconds, 60);
  assert.equal(describeRunPhase(input, TURN_START + 60_000, EN).timeText, "59s \u00b7 total 1m 00s");
  assert.equal(describeRunPhase(input, TURN_START + 61_000, EN).timeText, "1m 00s \u00b7 total 1m 01s");
  // A clock that steps back, or a zero timestamp, shows zero instead of a negative or huge value.
  assert.equal(describeRunPhase(input, TURN_START - 5_000, EN).totalSeconds, 0);
  assert.equal(describeRunPhase(input, TURN_START - 5_000, EN).phaseSeconds, 0);
  const unknown = Object.freeze({ phase: "thinking" as const, turnStartedAtMs: 0, phaseStartedAtMs: 0 });
  assert.equal(describeRunPhase(unknown, 1_800_000_000_000, EN).timeText, "total 0s");
});
