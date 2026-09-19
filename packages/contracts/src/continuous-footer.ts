export type ContinuousFooter = Readonly<{
  body: string;
  summary: string;
  remaining: string;
  verdict: "CONTINUE" | "COMPLETE" | "BLOCKED";
}>;

const FOOTER_INDENT = " {0,3}";

/**
 * Parse the control footer only when it is the final, unfenced three-line block.
 * This keeps protocol examples and an earlier, subsequently corrected footer as
 * ordinary assistant text instead of letting them drive the task controller.
 */
export function parseContinuousFooter(text: string): ContinuousFooter | undefined {
  const lines = text.trimEnd().split(/\r?\n/u);
  if (lines.length < 3) return undefined;
  const summary = new RegExp(`^${FOOTER_INDENT}GUILD_CONTINUOUS_SUMMARY:[ \\t]*(\\S.*)$`, "u")
    .exec(lines.at(-3)!);
  const remaining = new RegExp(`^${FOOTER_INDENT}GUILD_CONTINUOUS_REMAINING:[ \\t]*(\\S.*)$`, "u")
    .exec(lines.at(-2)!);
  const verdict = new RegExp(`^${FOOTER_INDENT}GUILD_CONTINUOUS_VERDICT:[ \\t]*(CONTINUE|COMPLETE|BLOCKED)[ \\t]*$`, "u")
    .exec(lines.at(-1)!);
  if (summary === null || remaining === null || verdict === null) return undefined;

  let fence: string | undefined;
  for (const line of lines.slice(0, -3)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker === null) continue;
    if (fence === undefined) fence = marker[1]!;
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === "") {
      fence = undefined;
    }
  }
  if (fence !== undefined) return undefined;

  return Object.freeze({
    body: lines.slice(0, -3).join("\n").trimEnd(),
    summary: summary[1]!.trim(),
    remaining: remaining[1]!.trim(),
    verdict: verdict[1] as ContinuousFooter["verdict"],
  });
}
