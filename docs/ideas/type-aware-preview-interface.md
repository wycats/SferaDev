# Type-Aware Preview Interface

**Status**: Follow-up idea from characterization reliability work  
**Date**: 2026-02-17  
**Context**: During the characterization reliability overhaul, we identified that
different response types need different preview strategies.

## Problem

The current `generatePreview()` function treats all response text the same way:
extract the first ~15 characters. This works well for text-heavy responses but
produces poor previews for tool-heavy responses where the text might be minimal
or just "I'll help you with that."

## Proposed Design

Introduce a `PreviewStrategy` interface that selects a preview approach based on
the response content:

```typescript
interface PreviewStrategy {
  /** Generate a preview label from the available response data. */
  preview(entry: AIResponseEntry): string | undefined;
}
```

### Strategy Selection

| Response Shape                    | Strategy          | Example Preview             |
| --------------------------------- | ----------------- | --------------------------- |
| Text-heavy (>100 chars, 0 tools)  | `TextPreview`     | `⋯ I've refactored…`        |
| Tool-heavy (≤100 chars, 1+ tools) | `ToolPreview`     | `⋯ read_file → grep_search` |
| Mixed (>100 chars, 1+ tools)      | `TextPreview`     | `⋯ Investigated the…`       |
| Minimal text, no tools            | `FallbackPreview` | `⋯`                         |

### ToolPreview Details

For tool-heavy responses, the preview could show the tool call sequence:

- Single tool: `⋯ read_file(src/main.ts)`
- Multiple tools: `⋯ read_file → grep_search → replace_string`
- Many tools: `⋯ read_file → grep_search +3`

This leverages the existing `summarizeToolArgs()` infrastructure in
`tool-labels.ts`.

### Integration Point

The `AIResponseItem.getLabel()` method currently calls `generatePreview()`.
Replace that with a strategy dispatch:

```typescript
const preview = selectPreviewStrategy(entry).preview(entry);
```

## Why Not Now

The current `generatePreview()` is a significant improvement over "Response #N"
and handles the common case well. The type-aware strategy adds complexity that
should be validated against real usage patterns first.

## Implementation Notes

- The `responseText` and `toolCalls` fields are now stored on `AIResponseEntry`,
  so all data needed for strategy selection is available.
- The `summarizeToolArgs()` and `toolIcon()` functions in `tool-labels.ts` can
  be reused for tool-based previews.
- Consider whether the strategy should also influence the icon (e.g., tool-heavy
  responses could use a different icon variant).
