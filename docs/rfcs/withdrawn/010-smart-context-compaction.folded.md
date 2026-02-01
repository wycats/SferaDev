# RFC 010: Smart Context Compaction

## Status: Stage 0 (Strawman)

This RFC is a research placeholder. Implementation requires significant investigation.

## Problem

VS Code's built-in summarization treats all messages equally, losing important context:
- Code snippets get summarized into prose descriptions
- Error messages and stack traces lose detail
- The user's original intent gets buried
- Tool call/result pairs get separated or mangled

With accurate token counting (RFC 009), we now know exactly how much context we have. We should use it more intelligently.

## Research Questions

Before implementation, we need to answer:

1. **Interception point**: Can we intercept and transform messages before VS Code sends them? Or do we need to maintain our own shadow history?

2. **LLM summarization**: Do we call an LLM for summaries, or can we do effective compaction heuristically?

3. **User control**: Should users be able to configure compaction aggressiveness or see what was compacted?

4. **Multi-turn coherence**: How do we ensure the model understands that some context is summarized vs. verbatim?

## Potential Strategies

### Strategy A: Sliding Window + Anchors

```
[System Prompt]
[Original User Request]        ← Always preserved
[Structured Summary]           ← Middle messages compacted
[Recent N messages]            ← Fresh context
```

**Pros**: Simple mental model, preserves intent  
**Cons**: Summary quality depends on LLM call

### Strategy B: Semantic Chunking

Group messages by semantic purpose:
- **Intent chunks**: User requests and clarifications
- **Work chunks**: Tool calls, code generation, edits
- **Result chunks**: Outputs, errors, confirmations

Compress each chunk type differently:
- Intent: Preserve verbatim or light summary
- Work: Extract "what changed" as structured data
- Result: Keep errors verbatim, summarize success

### Strategy C: Fact Extraction

Instead of summarizing prose, extract structured facts:

```typescript
interface ExtractedContext {
  files: Map<string, FileState>;      // path → last known state
  decisions: Decision[];               // what was decided and why
  errors: ErrorContext[];              // errors encountered
  currentTask: string;                 // what we're working on
}
```

Render this as a structured context block rather than conversation history.

### Strategy D: Hybrid Compression

Different compression ratios for different content:
- **Code blocks**: Keep verbatim or not at all (can re-read file)
- **Error messages**: Keep verbatim (critical for debugging)
- **Explanations**: Aggressive summarization OK
- **Tool results**: Extract key facts, discard formatting

## Token Budget Model

```
Total Context = System + History + Current Turn + Response Reserve

History Budget = Total - System - CurrentTurn - Reserve
               = contextWindow - ~2000 - currentTokens - maxOutputTokens

Compaction triggers when: actualHistory > historyBudget * 0.8
Target after compaction: actualHistory ≈ historyBudget * 0.5
```

## Implementation Sketch

```typescript
interface CompactionStrategy {
  shouldCompact(history: Message[], budget: number): boolean;
  compact(history: Message[], budget: number): Promise<Message[]>;
}

class SmartCompactor implements CompactionStrategy {
  constructor(
    private tokenCounter: TokenCounter,
    private llm?: LanguageModel  // optional, for summarization
  ) {}

  shouldCompact(history, budget) {
    const used = this.tokenCounter.countMessages(history);
    return used > budget * 0.8;
  }

  async compact(history, budget) {
    const anchors = this.identifyAnchors(history);
    const middle = this.getMiddleSection(history, anchors);
    
    if (this.llm) {
      const summary = await this.summarize(middle);
      return [anchors.first, summary, ...anchors.recent];
    } else {
      // Heuristic compaction
      return this.heuristicCompact(history, budget);
    }
  }

  private identifyAnchors(history: Message[]) {
    return {
      first: history.find(m => m.role === 'user'),
      recent: history.slice(-6),  // Last 3 exchanges
    };
  }

  private heuristicCompact(history, budget) {
    // Remove assistant explanations, keep user messages and code
    // Remove successful tool results, keep errors
    // Truncate long outputs
  }
}
```

## Open Questions

1. **Where does compaction happen?**
   - In the provider before forwarding?
   - As a middleware layer?
   - By maintaining our own conversation state?

2. **How do we handle VS Code's own summarization?**
   - Disable it somehow?
   - Let it run but pre-compact so it rarely triggers?
   - Coordinate with it?

3. **What about tool state?**
   - If we remove tool call/result pairs, does the model get confused?
   - Do we need synthetic "here's what happened" messages?

4. **Streaming considerations?**
   - Compaction needs to happen between turns, not during streaming
   - Need to track conversation state across requests

## Prior Art to Research

- Anthropic's context caching and prompt structure recommendations
- LangChain's conversation memory strategies
- AutoGPT/AgentGPT context management
- Academic work on dialogue state tracking

## Success Metrics

- Longer effective conversations before quality degradation
- Preserved ability to reference earlier decisions
- No "forgetting" of the original task
- Measurable via user testing or synthetic benchmarks

## Dependencies

- RFC 009 (Token Counting) - ✅ Implemented
- RFC 008 (Model Identity) - ✅ Implemented (needed for model-specific budgets)

## Next Steps

1. Research VS Code's summarization internals
2. Prototype heuristic compaction (no LLM)
3. Measure baseline conversation length limits
4. Test with real coding sessions
