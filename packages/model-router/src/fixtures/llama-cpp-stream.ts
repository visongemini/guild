/**
 * Event order recorded from llama.cpp `/v1/messages` (docs/20 section 2, "llama.cpp SSE").
 * It opens the text block (index 1) before closing the thinking block (index 0) and sends
 * block 0's `signature_delta` after the text block started.
 */
export function sseEvent(payload: Record<string, unknown>): string {
  return `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export const MESSAGE_START = {
  type: "message_start",
  message: {
    id: "msg_local_1",
    type: "message",
    role: "assistant",
    model: "local-27b",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 12, output_tokens: 0 },
  },
};
export const THINKING_START = {
  type: "content_block_start",
  index: 0,
  content_block: { type: "thinking", thinking: "", signature: "" },
};
export const THINKING_DELTA = {
  type: "content_block_delta",
  index: 0,
  delta: { type: "thinking_delta", thinking: "Let me think." },
};
export const TEXT_START = {
  type: "content_block_start",
  index: 1,
  content_block: { type: "text", text: "" },
};
export const TEXT_DELTA = {
  type: "content_block_delta",
  index: 1,
  delta: { type: "text_delta", text: "Hello there." },
};
export const SIGNATURE_DELTA = {
  type: "content_block_delta",
  index: 0,
  delta: { type: "signature_delta", signature: "" },
};
export const STOP_0 = { type: "content_block_stop", index: 0 };
export const STOP_1 = { type: "content_block_stop", index: 1 };
export const MESSAGE_DELTA = {
  type: "message_delta",
  delta: { stop_reason: "end_turn", stop_sequence: null },
  usage: { output_tokens: 5 },
};
export const MESSAGE_STOP = { type: "message_stop" };

/** As llama.cpp emits it. */
export const LLAMA_CPP_EVENTS: readonly Record<string, unknown>[] = [
  MESSAGE_START,
  THINKING_START,
  THINKING_DELTA,
  TEXT_START,
  TEXT_DELTA,
  SIGNATURE_DELTA,
  STOP_0,
  STOP_1,
  MESSAGE_DELTA,
  MESSAGE_STOP,
];

/** What a conformant client expects: every block is complete before the next one starts. */
export const NORMALIZED_EVENTS: readonly Record<string, unknown>[] = [
  MESSAGE_START,
  THINKING_START,
  THINKING_DELTA,
  SIGNATURE_DELTA,
  STOP_0,
  TEXT_START,
  TEXT_DELTA,
  STOP_1,
  MESSAGE_DELTA,
  MESSAGE_STOP,
];
