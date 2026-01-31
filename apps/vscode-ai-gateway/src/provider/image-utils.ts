import { logger } from "../logger.js";

/**
 * Detect image MIME type from magic bytes.
 * The API requires specific types (image/jpeg, image/png, image/gif, image/webp)
 * but VS Code may pass "image/*" wildcard which gets rejected.
 */
export function detectImageMimeType(
  data: Uint8Array,
  fallbackMimeType: string,
): string {
  // If already a specific type, use it
  if (
    fallbackMimeType !== "image/*" &&
    !fallbackMimeType.includes("*") &&
    fallbackMimeType.startsWith("image/")
  ) {
    return fallbackMimeType;
  }

  // Detect from magic bytes
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF: 47 49 46 38 (GIF8)
  if (
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return "image/gif";
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }

  // Default to PNG if we can't detect (most common for screenshots)
  logger.warn(
    `[OpenResponses] Could not detect image type from magic bytes, defaulting to image/png`,
  );
  return "image/png";
}
