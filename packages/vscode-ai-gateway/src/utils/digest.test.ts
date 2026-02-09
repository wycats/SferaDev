import { describe, it, expect } from "vitest";
import { computeNormalizedDigest } from "./digest";
import { STATEFUL_MARKER_MIME } from "./stateful-marker";

describe("Digest Collision Audit", () => {
  // 1. Audit TokenCache behavior (computeNormalizedDigest)
  it("should preserve markdown links in normalized digest", () => {
    function createTextMsg(text: string, role: number = 1) {
      return {
        role,
        content: [{ value: text }],
      } as any;
    }

    const rawText = "Hello world";
    const textWithAddition = "Hello world [Title](url)";
    const textWithDifferentLink = "Hello world [Title](url-2)";

    const digestRaw = computeNormalizedDigest(createTextMsg(rawText));
    const digestAdded = computeNormalizedDigest(
      createTextMsg(textWithAddition),
    );
    const digestDifferentLink = computeNormalizedDigest(
      createTextMsg(textWithDifferentLink),
    );

    expect(digestAdded).not.toBe(digestRaw);
    expect(digestDifferentLink).not.toBe(digestAdded);
  });

  // 2. Normalized digest should be stable for identical link text
  it("should keep normalized digest stable for identical markdown links", () => {
    function createTextMsg(text: string, role: number = 1) {
      return {
        role,
        content: [{ value: text }],
      } as any;
    }

    const text = "Check this [Link](http://example.com)";
    const digestA = computeNormalizedDigest(createTextMsg(text));
    const digestB = computeNormalizedDigest(createTextMsg(text));

    expect(digestA).toBe(digestB);
  });

  // 3. Data parts with invalid MIME types (metadata) should be excluded from hash
  it("should exclude data parts with invalid MIME types from normalized digest", () => {
    function createMsgWithDataPart(text: string, mimeType: string) {
      return {
        role: 1,
        content: [
          { value: text },
          { data: new Uint8Array([1, 2, 3]), mimeType },
        ],
      } as any;
    }

    const textOnly = { role: 1, content: [{ value: "Hello" }] } as any;
    const withCacheControl = createMsgWithDataPart("Hello", "cache_control");
    const withValidMime = createMsgWithDataPart("Hello", "image/png");
    const withStatefulMarker = createMsgWithDataPart(
      "Hello",
      STATEFUL_MARKER_MIME,
    );

    // cache_control (invalid MIME) should be ignored - same hash as text-only
    expect(computeNormalizedDigest(withCacheControl)).toBe(
      computeNormalizedDigest(textOnly),
    );

    // image/png (valid MIME) should be included - different hash
    expect(computeNormalizedDigest(withValidMime)).not.toBe(
      computeNormalizedDigest(textOnly),
    );

    // stateful marker should be ignored like metadata
    expect(computeNormalizedDigest(withStatefulMarker)).toBe(
      computeNormalizedDigest(textOnly),
    );
  });
});
