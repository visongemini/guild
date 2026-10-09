/**
 * Splits an append-only Markdown stream into blocks that can be parsed and rendered
 * independently, so a growing message re-parses only its last block per frame.
 *
 * The split is deliberately conservative: it commits a boundary only at a blank line outside a
 * fenced code block, when the following line starts at column 0, and never between two list
 * items. Constructs whose meaning depends on other parts of the text (link reference
 * definitions, footnotes, raw HTML blocks) disable splitting for the whole message. Once the
 * message stops streaming it is rendered as a single document, so the final output is exactly
 * what one parse would produce.
 */

const LIST_MARKER = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/u;
const UNSAFE_CONSTRUCT = /^ {0,3}\[[^\]\n]+\]:|\[\^|<(?:!--|script|pre|style|textarea|!\[CDATA\[)/imu;

type Fence = { readonly char: string; readonly length: number };

export class StreamingMarkdownSplitter {
  private text = "";
  private blocks: string[] = [];
  private blockStart = 0;
  private blockHasContent = false;
  private blockHasListMarker = false;
  private scanPosition = 0;
  private blankRunStart = -1;
  private fence: Fence | undefined;
  private unsafe = false;

  /**
   * Returns every committed block followed by the still-growing tail. The array always has at
   * least one element and concatenates (with separators) back to `text`.
   */
  update(text: string): readonly string[] {
    if (!text.startsWith(this.text)) this.reset();
    this.text = text;
    if (this.unsafe) return [text];
    while (true) {
      const newline = text.indexOf("\n", this.scanPosition);
      if (newline === -1) break;
      const lineStart = this.scanPosition;
      this.scanPosition = newline + 1;
      let line = text.slice(lineStart, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.scanLine(line, lineStart);
      if (this.unsafe) {
        this.blocks = [];
        return [text];
      }
    }
    // A partial last line never decides a boundary, but it can already make splitting unsafe.
    if (UNSAFE_CONSTRUCT.test(text.slice(this.scanPosition))) {
      this.unsafe = true;
      this.blocks = [];
      return [text];
    }
    return [...this.blocks, text.slice(this.blockStart)];
  }

  private scanLine(line: string, lineStart: number): void {
    if (this.fence !== undefined) {
      if (closesFence(line, this.fence)) this.fence = undefined;
      return;
    }
    if (line.trim().length === 0) {
      if (this.blankRunStart < 0) this.blankRunStart = lineStart;
      return;
    }
    if (UNSAFE_CONSTRUCT.test(line)) {
      this.unsafe = true;
      return;
    }
    const isListMarker = LIST_MARKER.test(line);
    if (
      this.blankRunStart >= 0 &&
      this.blockHasContent &&
      canStartIndependentBlock(line, isListMarker, this.blockHasListMarker)
    ) {
      this.blocks.push(this.text.slice(this.blockStart, this.blankRunStart));
      this.blockStart = lineStart;
      this.blockHasContent = false;
      this.blockHasListMarker = false;
    }
    this.blankRunStart = -1;
    this.blockHasContent = true;
    if (isListMarker) this.blockHasListMarker = true;
    const open = FENCE_OPEN.exec(line);
    if (open !== null) this.fence = { char: open[1]![0]!, length: open[1]!.length };
  }

  private reset(): void {
    this.text = "";
    this.blocks = [];
    this.blockStart = 0;
    this.blockHasContent = false;
    this.blockHasListMarker = false;
    this.scanPosition = 0;
    this.blankRunStart = -1;
    this.fence = undefined;
    this.unsafe = false;
  }
}

function canStartIndependentBlock(
  line: string,
  isListMarker: boolean,
  previousBlockHasListMarker: boolean,
): boolean {
  // Indented text can continue the previous block (list item body, indented code).
  if (/^\s/u.test(line)) return false;
  // Loose lists keep their items in one list.
  if (isListMarker && previousBlockHasListMarker) return false;
  return true;
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.replace(/^ {0,3}/u, "");
  let count = 0;
  while (trimmed[count] === fence.char) count += 1;
  return count >= fence.length && trimmed.slice(count).trim().length === 0;
}

/** One-shot split for tests and non-incremental callers. */
export function splitStreamingMarkdown(text: string): readonly string[] {
  return new StreamingMarkdownSplitter().update(text);
}
