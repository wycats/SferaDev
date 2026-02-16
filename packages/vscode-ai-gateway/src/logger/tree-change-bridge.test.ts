import { describe, expect, it } from "vitest";
import type { InvestigationEvent } from "./investigation-events.js";
import type {
  TreeChangeEvent,
  ChangeDetails,
  TreeSnapshot,
} from "../diagnostics/tree-change-log.js";
import { createTreeChangeBridge } from "./tree-change-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSnapshot(conversationId = "conv-1"): TreeSnapshot {
  return {
    conversations: [{ id: conversationId }],
  } as any;
}

function makeChange(): ChangeDetails {
  return { type: "added", conversationId: "conv-1" } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createTreeChangeBridge", () => {
  const sessionId = "test-session";

  it("emits tree.change events", () => {
    const emitted: InvestigationEvent[] = [];
    const bridge = createTreeChangeBridge(sessionId, (e) => emitted.push(e));

    bridge(
      "CONVERSATION_ADDED" as TreeChangeEvent,
      makeChange(),
      makeSnapshot(),
      "chat-42",
    );

    expect(emitted).toHaveLength(1);
    const e = emitted[0] as any;
    expect(e.kind).toBe("tree.change");
    expect(e.sessionId).toBe(sessionId);
    expect(e.causedByChatId).toBe("chat-42");
    expect(e.chatId).toBe("chat-42");
    expect(e.event).toBe("CONVERSATION_ADDED");
  });

  it("uses first conversation ID from snapshot", () => {
    const emitted: InvestigationEvent[] = [];
    const bridge = createTreeChangeBridge(sessionId, (e) => emitted.push(e));

    bridge(
      "TREE_INITIALIZED" as TreeChangeEvent,
      makeChange(),
      makeSnapshot("my-conv"),
      "chat-1",
    );

    expect((emitted[0] as any).conversationId).toBe("my-conv");
  });

  it("falls back to 'unknown' when causedByChatId is undefined", () => {
    const emitted: InvestigationEvent[] = [];
    const bridge = createTreeChangeBridge(sessionId, (e) => emitted.push(e));

    bridge(
      "CONVERSATION_UPDATED" as TreeChangeEvent,
      makeChange(),
      makeSnapshot(),
      undefined,
    );

    const e = emitted[0] as any;
    expect(e.chatId).toBe("unknown");
    expect(e.causedByChatId).toBeNull();
  });

  it("falls back to 'unknown' when snapshot has no conversations", () => {
    const emitted: InvestigationEvent[] = [];
    const bridge = createTreeChangeBridge(sessionId, (e) => emitted.push(e));

    const emptySnapshot = { conversations: [] } as any;
    bridge(
      "CONVERSATION_REMOVED" as TreeChangeEvent,
      makeChange(),
      emptySnapshot,
      "chat-1",
    );

    expect((emitted[0] as any).conversationId).toBe("unknown");
  });

  it("generates unique eventIds", () => {
    const emitted: InvestigationEvent[] = [];
    const bridge = createTreeChangeBridge(sessionId, (e) => emitted.push(e));

    for (let i = 0; i < 10; i++) {
      bridge(
        "CONVERSATION_UPDATED" as TreeChangeEvent,
        makeChange(),
        makeSnapshot(),
        `chat-${i}`,
      );
    }

    const ids = emitted.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(10);
  });
});
