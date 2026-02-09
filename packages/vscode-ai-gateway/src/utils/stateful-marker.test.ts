import { describe, it, expect } from "vitest";
import {
  CustomDataPartMimeTypes,
  STATEFUL_MARKER_MIME,
  isStatefulMarkerMime,
  isMetadataMime,
  encodeStatefulMarker,
  decodeStatefulMarker,
  findLatestStatefulMarker,
  encodeThinkingData,
  decodeThinkingData,
  type ThinkingData,
} from "./stateful-marker";

describe("CustomDataPartMimeTypes", () => {
  it("defines all four VS Code persisted MIME types", () => {
    expect(CustomDataPartMimeTypes.CacheControl).toBe("cache_control");
    expect(CustomDataPartMimeTypes.StatefulMarker).toBe("stateful_marker");
    expect(CustomDataPartMimeTypes.ThinkingData).toBe("thinking");
    expect(CustomDataPartMimeTypes.ContextManagement).toBe(
      "context_management",
    );
  });

  it("STATEFUL_MARKER_MIME is aliased for backward compatibility", () => {
    expect(STATEFUL_MARKER_MIME).toBe(CustomDataPartMimeTypes.StatefulMarker);
    expect(STATEFUL_MARKER_MIME).toBe("stateful_marker");
  });
});

describe("isStatefulMarkerMime", () => {
  it("returns true for stateful_marker MIME type", () => {
    expect(isStatefulMarkerMime("stateful_marker")).toBe(true);
  });

  it("returns false for other VS Code persisted MIME types", () => {
    expect(isStatefulMarkerMime("cache_control")).toBe(false);
    expect(isStatefulMarkerMime("thinking")).toBe(false);
    expect(isStatefulMarkerMime("context_management")).toBe(false);
  });

  it("returns false for standard MIME types", () => {
    expect(isStatefulMarkerMime("text/plain")).toBe(false);
    expect(isStatefulMarkerMime("application/json")).toBe(false);
    expect(isStatefulMarkerMime("image/png")).toBe(false);
  });

  it("returns false for empty or malformed strings", () => {
    expect(isStatefulMarkerMime("")).toBe(false);
    expect(isStatefulMarkerMime("stateful_marker_extended")).toBe(false);
    expect(isStatefulMarkerMime("STATEFUL_MARKER")).toBe(false);
  });
});

describe("isMetadataMime", () => {
  it("returns true for stateful_marker MIME type", () => {
    expect(isMetadataMime("stateful_marker")).toBe(true);
  });

  it("returns true for thinking MIME type", () => {
    expect(isMetadataMime("thinking")).toBe(true);
  });

  it("returns false for other VS Code persisted MIME types", () => {
    expect(isMetadataMime("cache_control")).toBe(false);
    expect(isMetadataMime("context_management")).toBe(false);
  });

  it("returns false for standard MIME types", () => {
    expect(isMetadataMime("text/plain")).toBe(false);
    expect(isMetadataMime("application/json")).toBe(false);
    expect(isMetadataMime("image/png")).toBe(false);
  });

  it("returns false for empty or malformed strings", () => {
    expect(isMetadataMime("")).toBe(false);
    expect(isMetadataMime("thinking_extended")).toBe(false);
    expect(isMetadataMime("THINKING")).toBe(false);
  });
});

describe("encodeStatefulMarker", () => {
  it("encodes marker with modelId\\JSON format", () => {
    const marker = {
      provider: "openresponses",
      modelId: "claude-sonnet-4-20250514",
      sdkMode: "openai-responses",
      sessionId: "sess_123",
      responseId: "resp_456",
    };
    const encoded = encodeStatefulMarker("claude-sonnet-4-20250514", marker);
    const decoded = new TextDecoder().decode(encoded);

    expect(decoded).toContain("claude-sonnet-4-20250514\\");
    expect(decoded).toContain('"responseId":"resp_456"');
    expect(decoded).toContain('"extension":"sferadev.vscode-ai-gateway"');
  });

  it("automatically adds extension field", () => {
    const marker = {
      provider: "test",
      modelId: "test-model",
      sdkMode: "test-sdk",
      sessionId: "sess",
      responseId: "resp",
    };
    const encoded = encodeStatefulMarker("test-model", marker);
    const decoded = new TextDecoder().decode(encoded);
    const parts = decoded.split("\\");
    expect(parts[1]).toBeDefined();
    const json = JSON.parse(parts[1]!);

    expect(json.extension).toBe("sferadev.vscode-ai-gateway");
  });

  it("preserves optional expireAt field", () => {
    const marker = {
      provider: "openresponses",
      modelId: "model",
      sdkMode: "sdk",
      sessionId: "sess",
      responseId: "resp",
      expireAt: 1234567890000,
    };
    const encoded = encodeStatefulMarker("model", marker);
    const decoded = new TextDecoder().decode(encoded);

    expect(decoded).toContain('"expireAt":1234567890000');
  });
});

describe("decodeStatefulMarker", () => {
  it("decodes valid encoded marker", () => {
    const marker = {
      provider: "openresponses",
      modelId: "claude-sonnet-4-20250514",
      sdkMode: "openai-responses",
      sessionId: "sess_123",
      responseId: "resp_456",
    };
    const encoded = encodeStatefulMarker("claude-sonnet-4-20250514", marker);
    const result = decodeStatefulMarker(encoded);

    expect(result).toBeDefined();
    expect(result!.modelId).toBe("claude-sonnet-4-20250514");
    expect(result!.marker.responseId).toBe("resp_456");
    expect(result!.marker.extension).toBe("sferadev.vscode-ai-gateway");
  });

  it("returns undefined for data without backslash separator", () => {
    const data = new TextEncoder().encode('{"responseId":"test"}');
    expect(decodeStatefulMarker(data)).toBeUndefined();
  });

  it("returns undefined for invalid JSON payload", () => {
    const data = new TextEncoder().encode("model\\{not valid json}");
    expect(decodeStatefulMarker(data)).toBeUndefined();
  });

  it("returns undefined for marker missing responseId", () => {
    const data = new TextEncoder().encode(
      'model\\{"extension":"test","provider":"test"}',
    );
    expect(decodeStatefulMarker(data)).toBeUndefined();
  });

  it("returns undefined for marker missing extension", () => {
    const data = new TextEncoder().encode(
      'model\\{"responseId":"test","provider":"test"}',
    );
    expect(decodeStatefulMarker(data)).toBeUndefined();
  });

  it("handles modelId with special characters", () => {
    const marker = {
      provider: "test",
      modelId: "anthropic/claude-3.5-sonnet",
      sdkMode: "test",
      sessionId: "sess",
      responseId: "resp",
    };
    const encoded = encodeStatefulMarker("anthropic/claude-3.5-sonnet", marker);
    const result = decodeStatefulMarker(encoded);

    expect(result).toBeDefined();
    expect(result!.modelId).toBe("anthropic/claude-3.5-sonnet");
  });
});

describe("findLatestStatefulMarker", () => {
  function createMessage(
    role: number,
    parts: Array<{ value?: string; data?: Uint8Array; mimeType?: string }>,
  ) {
    return {
      role,
      content: parts.map((p) => {
        if (p.value !== undefined) return { value: p.value };
        return { data: p.data, mimeType: p.mimeType };
      }),
    } as any;
  }

  function createMarkerData(responseId: string): Uint8Array {
    return encodeStatefulMarker("test-model", {
      provider: "openresponses",
      modelId: "test-model",
      sdkMode: "openai-responses",
      sessionId: "sess",
      responseId,
    });
  }

  it("finds marker in last assistant message", () => {
    const markerData = createMarkerData("resp_123");
    const messages = [
      createMessage(1, [{ value: "Hello" }]), // User
      createMessage(2, [
        { value: "Response" },
        { data: markerData, mimeType: "stateful_marker" },
      ]), // Assistant
    ];

    const result = findLatestStatefulMarker(messages, "test-model");
    expect(result).toBeDefined();
    expect(result!.responseId).toBe("resp_123");
  });

  it("finds most recent marker when multiple exist", () => {
    const markerOld = createMarkerData("resp_old");
    const markerNew = createMarkerData("resp_new");
    const messages = [
      createMessage(1, [{ value: "Hello" }]),
      createMessage(2, [
        { value: "First" },
        { data: markerOld, mimeType: "stateful_marker" },
      ]),
      createMessage(1, [{ value: "Another question" }]),
      createMessage(2, [
        { value: "Second" },
        { data: markerNew, mimeType: "stateful_marker" },
      ]),
    ];

    const result = findLatestStatefulMarker(messages, "test-model");
    expect(result).toBeDefined();
    expect(result!.responseId).toBe("resp_new");
  });

  it("returns undefined for empty messages array", () => {
    expect(findLatestStatefulMarker([], "test-model")).toBeUndefined();
  });

  it("returns undefined when no assistant messages exist", () => {
    const messages = [
      createMessage(1, [{ value: "Hello" }]), // User
      createMessage(3, [{ value: "System" }]), // System
    ];
    expect(findLatestStatefulMarker(messages, "test-model")).toBeUndefined();
  });

  it("returns undefined when assistant message has no DataPart", () => {
    const messages = [
      createMessage(1, [{ value: "Hello" }]),
      createMessage(2, [{ value: "Response" }]), // Text only
    ];
    expect(findLatestStatefulMarker(messages, "test-model")).toBeUndefined();
  });

  it("skips DataParts with wrong MIME type", () => {
    const dataPartOther = new Uint8Array([1, 2, 3]);
    const messages = [
      createMessage(1, [{ value: "Hello" }]),
      createMessage(2, [
        { value: "Response" },
        { data: dataPartOther, mimeType: "cache_control" },
      ]),
    ];
    expect(findLatestStatefulMarker(messages, "test-model")).toBeUndefined();
  });

  it("skips markers from other extensions", () => {
    // Create a marker with a different extension
    const foreignMarker = new TextEncoder().encode(
      'model\\{"extension":"other.extension","responseId":"foreign","provider":"test","modelId":"test","sdkMode":"test","sessionId":"sess"}',
    );
    const messages = [
      createMessage(1, [{ value: "Hello" }]),
      createMessage(2, [
        { value: "Response" },
        { data: foreignMarker, mimeType: "stateful_marker" },
      ]),
    ];

    expect(findLatestStatefulMarker(messages, "test-model")).toBeUndefined();
  });

  it("finds our marker when mixed with other extension markers", () => {
    const foreignMarker = new TextEncoder().encode(
      'model\\{"extension":"other.extension","responseId":"foreign","provider":"test","modelId":"test","sdkMode":"test","sessionId":"sess"}',
    );
    const ourMarker = createMarkerData("our_resp");
    const messages = [
      createMessage(1, [{ value: "Hello" }]),
      createMessage(2, [
        { value: "Response 1" },
        { data: foreignMarker, mimeType: "stateful_marker" },
      ]),
      createMessage(1, [{ value: "Follow up" }]),
      createMessage(2, [
        { value: "Response 2" },
        { data: ourMarker, mimeType: "stateful_marker" },
      ]),
    ];

    const result = findLatestStatefulMarker(messages, "test-model");
    expect(result).toBeDefined();
    expect(result!.responseId).toBe("our_resp");
  });

  it("handles corrupted DataPart data gracefully", () => {
    const corruptedData = new TextEncoder().encode("not\\valid{json");
    const messages = [
      createMessage(1, [{ value: "Hello" }]),
      createMessage(2, [
        { value: "Response" },
        { data: corruptedData, mimeType: "stateful_marker" },
      ]),
    ];

    expect(findLatestStatefulMarker(messages, "test-model")).toBeUndefined();
  });
});

describe("round-trip", () => {
  it("encode/decode preserves all marker fields", () => {
    const original = {
      provider: "openresponses",
      modelId: "claude-sonnet-4-20250514",
      sdkMode: "openai-responses" as const,
      sessionId: "sess_abc123",
      responseId: "resp_def456",
      expireAt: Date.now() + 3600000,
    };

    const encoded = encodeStatefulMarker(original.modelId, original);
    const decoded = decodeStatefulMarker(encoded);

    expect(decoded).toBeDefined();
    expect(decoded!.modelId).toBe(original.modelId);
    expect(decoded!.marker.provider).toBe(original.provider);
    expect(decoded!.marker.modelId).toBe(original.modelId);
    expect(decoded!.marker.sdkMode).toBe(original.sdkMode);
    expect(decoded!.marker.sessionId).toBe(original.sessionId);
    expect(decoded!.marker.responseId).toBe(original.responseId);
    expect(decoded!.marker.expireAt).toBe(original.expireAt);
    expect(decoded!.marker.extension).toBe("sferadev.vscode-ai-gateway");
  });
});

// ============================================================================
// ThinkingData Encode/Decode Tests
// ============================================================================

describe("encodeThinkingData", () => {
  it("encodes thinking data in ThinkingDataContainer format", () => {
    const thinking: ThinkingData = {
      id: "item_1:0",
      text: "Let me think about this...",
    };
    const encoded = encodeThinkingData(thinking);
    const decoded = JSON.parse(new TextDecoder().decode(encoded));
    expect(decoded).toEqual({
      type: "thinking",
      thinking: { id: "item_1:0", text: "Let me think about this..." },
    });
  });

  it("preserves metadata and tokens fields", () => {
    const thinking: ThinkingData = {
      id: "item_2:0",
      text: "Reasoning content",
      metadata: { signature: "abc123" },
      tokens: 42,
    };
    const encoded = encodeThinkingData(thinking);
    const decoded = JSON.parse(new TextDecoder().decode(encoded));
    expect(decoded.thinking.metadata).toEqual({ signature: "abc123" });
    expect(decoded.thinking.tokens).toBe(42);
  });

  it("handles text as string array", () => {
    const thinking: ThinkingData = {
      id: "item_3:0",
      text: ["first part", "second part"],
    };
    const encoded = encodeThinkingData(thinking);
    const decoded = JSON.parse(new TextDecoder().decode(encoded));
    expect(decoded.thinking.text).toEqual(["first part", "second part"]);
  });
});

describe("decodeThinkingData", () => {
  it("decodes valid ThinkingDataContainer", () => {
    const container = {
      type: "thinking",
      thinking: { id: "item_1:0", text: "Let me think..." },
    };
    const data = new TextEncoder().encode(JSON.stringify(container));
    const result = decodeThinkingData(data);
    expect(result).toEqual({ id: "item_1:0", text: "Let me think..." });
  });

  it("returns undefined for wrong type field", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({ type: "stateful_marker", thinking: { id: "x", text: "y" } }),
    );
    expect(decodeThinkingData(data)).toBeUndefined();
  });

  it("returns undefined for missing thinking field", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({ type: "thinking" }),
    );
    expect(decodeThinkingData(data)).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    const data = new TextEncoder().encode("not json");
    expect(decodeThinkingData(data)).toBeUndefined();
  });

  it("returns undefined for non-object thinking field", () => {
    const data = new TextEncoder().encode(
      JSON.stringify({ type: "thinking", thinking: "not an object" }),
    );
    expect(decodeThinkingData(data)).toBeUndefined();
  });
});

describe("ThinkingData round-trip", () => {
  it("encode -> decode preserves all fields", () => {
    const original: ThinkingData = {
      id: "item_1:0",
      text: "Let me analyze the problem step by step...",
      metadata: { signature: "sig_abc123" },
      tokens: 150,
    };
    const encoded = encodeThinkingData(original);
    const decoded = decodeThinkingData(encoded);
    expect(decoded).toEqual(original);
  });

  it("encode -> decode works with minimal fields", () => {
    const original: ThinkingData = {
      id: "item_2:1",
      text: "Simple thinking",
    };
    const encoded = encodeThinkingData(original);
    const decoded = decodeThinkingData(encoded);
    expect(decoded).toEqual(original);
  });
});
