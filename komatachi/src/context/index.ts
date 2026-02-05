/**
 * Context Window Module
 *
 * Pure function. Given a conversation history and a token budget,
 * select the messages that fit. Reports what was dropped so the caller
 * (Agent Loop) can decide whether to trigger compaction.
 *
 * Design principles:
 * - Pure function: no state, no side effects, no module dependencies
 * - Token budget is the only policy: no max-messages, no max-age rules
 * - Generic over message type: works with any message format
 * - Caller provides token estimation: no hidden dependency on compaction
 */

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Report of messages that did not fit within the token budget.
 */
export interface OverflowReport {
  /** Number of messages dropped from the beginning of history */
  readonly droppedCount: number;
  /** Estimated total tokens of dropped messages */
  readonly estimatedDroppedTokens: number;
}

/**
 * Result of message selection.
 */
export interface SelectionResult<T> {
  /** Messages that fit within the budget (contiguous block from end of history) */
  readonly selected: readonly T[];
  /** Overflow report if messages were dropped, null if all fit */
  readonly overflow: OverflowReport | null;
}

// -----------------------------------------------------------------------------
// Core Function
// -----------------------------------------------------------------------------

/**
 * Select the most recent messages that fit within a token budget.
 *
 * Walks backward from the most recent message, accumulating token counts.
 * Stops when the next message would exceed the budget. Returns a contiguous
 * block from the end of the history -- earlier messages are dropped as a unit.
 *
 * The token estimation function is injected, keeping this module free of
 * dependencies on any specific message format or estimation implementation.
 *
 * @param messages - Full conversation history in chronological order
 * @param tokenBudget - Maximum tokens for the selected messages
 * @param estimateTokens - Function to estimate token count of a single message
 * @returns Selected messages and an overflow report (null if all fit)
 */
export function selectMessages<T>(
  messages: readonly T[],
  tokenBudget: number,
  estimateTokens: (message: T) => number
): SelectionResult<T> {
  if (messages.length === 0) {
    return { selected: [], overflow: null };
  }

  let tokenAccumulator = 0;
  let firstSelectedIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i]);
    if (tokenAccumulator + msgTokens > tokenBudget) {
      break;
    }
    tokenAccumulator += msgTokens;
    firstSelectedIndex = i;
  }

  const selected = messages.slice(firstSelectedIndex);

  if (firstSelectedIndex === 0) {
    return { selected, overflow: null };
  }

  // Some messages were dropped from the beginning
  const dropped = messages.slice(0, firstSelectedIndex);
  const estimatedDroppedTokens = dropped.reduce(
    (sum, msg) => sum + estimateTokens(msg),
    0
  );

  return {
    selected,
    overflow: {
      droppedCount: dropped.length,
      estimatedDroppedTokens,
    },
  };
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Estimate the token count of a string.
 *
 * Uses the ~4 characters per token approximation for English text.
 * This is the same formula used by the compaction module's estimateTokens.
 *
 * Useful for the Agent Loop to estimate system prompt token count
 * when computing the token budget for selectMessages.
 */
export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
