/**
 * Minimal ULID generator for event IDs.
 *
 * ULIDs are 128-bit identifiers that sort lexicographically by time:
 *   - 48-bit timestamp (ms since epoch) → 10 Crockford base32 chars
 *   - 80-bit random → 16 Crockford base32 chars
 *
 * Monotonic: if two ULIDs are generated in the same millisecond,
 * the random component is incremented to preserve sort order.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Safe base32 char lookup — index is always 0..31 so this never returns undefined. */
function b32(index: number): string {
  return CROCKFORD.charAt(index);
}

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(ms: number, length: number): string {
  let result = "";
  for (let i = length - 1; i >= 0; i--) {
    const mod = ms % 32;
    result = b32(mod) + result;
    ms = Math.floor(ms / 32);
  }
  return result;
}

function encodeRandom(bytes: number[]): string {
  // Encode 80 bits (10 bytes) as 16 base32 chars
  // Process 5 bits at a time from the byte array
  let result = "";
  let buffer = 0;
  let bitsInBuffer = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsInBuffer += 8;

    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      result += b32((buffer >> bitsInBuffer) & 0x1f);
    }
  }

  return result;
}

function generateRandomBytes(): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 10; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  return bytes;
}

function incrementRandom(bytes: number[]): number[] {
  const result = [...bytes];
  for (let i = result.length - 1; i >= 0; i--) {
    const val = result[i];
    if (val !== undefined && val < 255) {
      result[i] = val + 1;
      return result;
    }
    result[i] = 0;
  }
  // Overflow — generate fresh random (astronomically unlikely)
  return generateRandomBytes();
}

/**
 * Generate a ULID string (26 chars, Crockford base32).
 *
 * Monotonic within the same millisecond: subsequent calls in the same ms
 * increment the random component to preserve lexicographic ordering.
 */
export function ulid(): string {
  const now = Date.now();

  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = generateRandomBytes();
  }

  return encodeTime(now, 10) + encodeRandom(lastRandom);
}
