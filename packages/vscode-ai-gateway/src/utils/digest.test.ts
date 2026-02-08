import { describe, it, expect } from "vitest";
import { computeStableMessageHash, computeNormalizedDigest } from "./digest";

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

  // 2. Audit ConversationStateTracker behavior (computeStableMessageHash)
  it("should generate distinct stable hashes for different tool inputs (FIXED)", () => {
    function createToolCallMsg(name: string, callId: string, input: any) {
      return {
        role: 2,
        content: [
          {
            callId,
            name,
            input,
          },
        ],
      } as any;
    }

    const toolA = createToolCallMsg("readFile", "call-1", { path: "A" });
    const toolB = createToolCallMsg("readFile", "call-1", { path: "B" });

    const hashA = computeStableMessageHash(toolA);
    const hashB = computeStableMessageHash(toolB);

    expect(hashA).not.toBe(hashB);
  });

  // 3. Normalized digest should be stable for identical link text
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

  // 4. Data parts with invalid MIME types (metadata) should be excluded from hash
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

    // cache_control (invalid MIME) should be ignored - same hash as text-only
    expect(computeNormalizedDigest(withCacheControl)).toBe(
      computeNormalizedDigest(textOnly),
    );

    // image/png (valid MIME) should be included - different hash
    expect(computeNormalizedDigest(withValidMime)).not.toBe(
      computeNormalizedDigest(textOnly),
    );
  });

  // 5. Same test for stable message hash
  it("should exclude data parts with invalid MIME types from stable hash", () => {
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

    // cache_control (invalid MIME) should be ignored - same hash as text-only
    expect(computeStableMessageHash(withCacheControl)).toBe(
      computeStableMessageHash(textOnly),
    );

    // image/png (valid MIME) should be included - different hash
    expect(computeStableMessageHash(withValidMime)).not.toBe(
      computeStableMessageHash(textOnly),
    );
  });
});
