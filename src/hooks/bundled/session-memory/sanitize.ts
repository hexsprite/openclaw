/**
 * Session memory sanitization.
 *
 * Quantized local model servers periodically leak chat-template control tokens
 * (e.g. `<|im_end|>`, `<|endoftext|>`) and unparsed `<tool_call>` XML blocks into
 * the assistant content channel. When those artifacts get persisted into the
 * per-agent memory file and re-injected as "Conversation Summary" context on
 * the next /new, the model interprets the embedded role markers as in-progress
 * chat-template scaffolding and emits more malformed output. The hook then
 * saves that malformed output, and the loop degrades the agent over time.
 *
 * This module strips the known artifact classes and flags structurally garbage
 * turns so the caller can elide them rather than persisting poison.
 */

/**
 * Chat-template control tokens emitted by common local-model chat templates
 * (Qwen, Llama, Mistral, generic). Matched case-sensitive, exact form.
 */
const CHAT_TEMPLATE_TOKENS =
  /<\|(?:im_start|im_end|endoftext|system|user|assistant|fim_prefix|fim_suffix|fim_middle|start_header_id|end_header_id|eot_id|begin_of_text|end_of_text|pad)\|>|<\/?(?:eos|bos)>/g;

/**
 * Raw `<tool_call>...</tool_call>` XML blocks that leaked into the content
 * channel before the parser converted them. Non-greedy so multiple blocks on
 * the same line are handled independently.
 */
const TOOL_CALL_XML = /<tool_call>[\s\S]*?<\/tool_call>/g;

/**
 * Lines that are nothing but a bare role label — either `role:` with optional
 * trailing whitespace, or the role word alone on a line. These are leaked
 * scaffolding, not legitimate content. In-sentence uses like "The user: asked
 * me..." are unaffected because they have surrounding text on the same line.
 */
const ORPHAN_ROLE_LINE = /^[ \t]*(?:assistant|user|system)[:\s]*$/gm;

/**
 * Runs of 3+ blank lines collapse to 2. Stripping above tends to leave blank
 * lines behind; this keeps the output tidy without changing paragraph breaks.
 */
const EXCESS_BLANK_LINES = /\n{3,}/g;

export interface SanitizeResult {
  /** Sanitized text. Meaningful only when `skipped` is false. */
  text: string;
  /** True when the caller should elide this turn entirely. */
  skipped: boolean;
  /** Ratio of content removed by sanitization; useful for observability. */
  strippedRatio: number;
  /** Original input length, in characters. */
  originalLength: number;
}

/**
 * Sanitize a raw assistant (or user) content string before it is persisted
 * into a memory file or re-injected as context.
 */
export function sanitizeAssistantContent(raw: string): SanitizeResult {
  const originalLength = raw.length;

  let cleaned = raw
    .replace(CHAT_TEMPLATE_TOKENS, "")
    .replace(TOOL_CALL_XML, "")
    .replace(ORPHAN_ROLE_LINE, "")
    .replace(EXCESS_BLANK_LINES, "\n\n");

  // Trim leading/trailing whitespace introduced by the stripping above,
  // but preserve internal newlines.
  cleaned = cleaned.replace(/^\s+|\s+$/g, "");

  const strippedRatio = originalLength === 0 ? 0 : (originalLength - cleaned.length) / originalLength;

  let skipped = false;
  const trimmed = cleaned.trim();
  if (trimmed === "") {
    skipped = true;
  } else if (trimmed.toUpperCase() === "NO_REPLY") {
    // NO_REPLY is housekeeping, not conversation content. Persisting it into
    // memory files re-injects it as "history" that makes the model think its
    // last reply was NO_REPLY, encouraging the same behavior next turn.
    skipped = true;
  } else if (strippedRatio > 0.5 && cleaned.length < 80) {
    // Most of the turn was garbage and what's left is too short to carry
    // meaningful context. Elide rather than persist a fragment.
    skipped = true;
  }

  return { text: cleaned, skipped, strippedRatio, originalLength };
}

/** Marker persisted in place of an elided turn, so operators can see the signal. */
export const ELIDED_TURN_MARKER = "[malformed turn elided]";
