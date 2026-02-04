/**
 * CapsuleGuard - Hallucination Defense for RFC 041 Transcript Capsule
 *
 * Monitors streaming LLM output for hallucinated capsule patterns.
 * When detected, immediately cancels the stream to prevent invalid
 * identity metadata from reaching the user.
 *
 * Design:
 * - Maintains a rolling buffer of recent characters
 * - Detects patterns like `<!-- v.cid:`, `<!-- v.aid:`, `<!-- v.pid:`
 * - Returns clean content (truncated before hallucination)
 * - Triggers cancellation via CancellationToken
 */

/**
 * Result of processing a text delta through the guard
 */
export interface CapsuleGuardResult {
  /** Whether the stream should be cancelled due to detected hallucination */
  shouldCancel: boolean;
  /** Clean content (may be truncated if hallucination detected) */
  cleanContent: string;
}

/**
 * Guard against hallucinated capsule patterns in LLM output
 */
export class CapsuleGuard {
  private buffer = "";
  private readonly BUFFER_SIZE = 30;
  private readonly PATTERN = /<!-- v\.(cid|aid|pid):/;

  /**
   * Process a text delta from the stream.
   * Returns { shouldCancel: boolean, cleanContent: string }
   *
   * @param text - The text delta from the stream
   * @returns CapsuleGuardResult indicating whether to cancel and the clean content
   */
  processTextDelta(text: string): CapsuleGuardResult {
    // Build the full buffer before truncation to detect patterns correctly
    const fullBuffer = this.buffer + text;

    // Check for hallucinated capsule pattern
    if (this.PATTERN.test(fullBuffer)) {
      // Find where in fullBuffer the pattern starts
      const match = this.PATTERN.exec(fullBuffer);
      const matchStart = match?.index ?? fullBuffer.length;

      // Determine where in the NEW TEXT the pattern starts
      const oldBufferLength = this.buffer.length;
      
      if (matchStart < oldBufferLength) {
        // Pattern started in previous buffer, entire current text is contaminated
        return { shouldCancel: true, cleanContent: "" };
      }
      
      // Pattern starts in the new text
      const hallucStartIndex = matchStart - oldBufferLength;
      const cleanContent = text.substring(0, hallucStartIndex);
      
      // Update buffer before returning (for consistency)
      this.buffer = fullBuffer;
      if (this.buffer.length > this.BUFFER_SIZE) {
        this.buffer = this.buffer.slice(-this.BUFFER_SIZE);
      }
      
      return { shouldCancel: true, cleanContent };
    }

    // No pattern detected, add text to buffer normally
    this.buffer += text;

    // Keep only last BUFFER_SIZE chars to limit memory
    if (this.buffer.length > this.BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-this.BUFFER_SIZE);
    }

    return { shouldCancel: false, cleanContent: text };
  }
}
