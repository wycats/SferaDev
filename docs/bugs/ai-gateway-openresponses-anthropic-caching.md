# Bug Report: OpenResponses Endpoint Missing Anthropic Prompt Caching Support

**Reporter:** Yehuda Katz  
**Date:** 2026-02-04  
**Severity:** High (significant cost impact)  
**Component:** ai-gateway `/v1/responses` endpoint  

---

## Summary

The OpenResponses endpoint (`/v1/responses`) does not support Anthropic prompt caching. The `instructions` field is converted to a system message without any `cache_control` metadata, and `providerOptions.anthropic.cacheControl` is passed through at the top level but never applied to individual message parts. The OpenResponses input schema also lacks `cache_control` fields, preventing clients from expressing Anthropic prompt caching.

In contrast, the Anthropic-compat endpoint (`/v1/messages`) properly maps `cache_control` to per-message `providerOptions`, demonstrating the expected behavior.

**Impact:** Users cannot use Anthropic's 90% cost reduction on cached tokens when using OpenResponses with Claude models. For long conversations, this results in 10-25x higher costs than necessary.

---

## Technical Analysis

### 1. System Message (Instructions) Missing cache_control

**File:** `lib/openresponses-compat/convert-to-aisdk-call-options.ts`  
**Lines:** 79-85

```typescript
  // Convert input items to AI SDK messages
  const messages = convertInputItemsToMessages(request.input);

  // Prepend instructions as system message
  if (request.instructions) {
    messages.unshift({ role: 'system', content: request.instructions });
  }
```

**Problem:** `instructions` is always converted to a system message with only `role` and `content`. There is no `providerOptions` or per-message `cacheControl` applied, so Anthropic prompt caching cannot be expressed for instructions.

---

### 2. providerOptions Passed Through But Not Applied to Messages

**File:** `lib/openresponses-compat/convert-to-aisdk-call-options.ts`  
**Lines:** 97-114

```typescript
  return {
    prompt: messages,
    ...(request.max_output_tokens !== undefined && {
      maxOutputTokens: request.max_output_tokens,
    }),
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.top_p !== undefined && { topP: request.top_p }),
    ...(request.presence_penalty !== undefined && {
      presencePenalty: request.presence_penalty,
    }),
    ...(request.frequency_penalty !== undefined && {
      frequencyPenalty: request.frequency_penalty,
    }),
    ...(Object.keys(providerOptions).length > 0 && {
      providerOptions: providerOptions as SharedV3ProviderOptions,
    }),
```

**Problem:** `providerOptions` is attached at the top-level call options, not to individual messages or content parts. Anthropic's caching requires per-message/per-part `cache_control`, but OpenResponses doesn't attach it to `prompt` messages.

---

### 3. Input Item Schema Missing cache_control

**File:** `lib/openresponses-compat/openresponses-compat-api-types.ts`  
**Lines:** 42-70

```typescript
const inputTextContentSchema = z.object({
  type: z.literal('input_text'),
  text: z.string(),
});

const outputTextContentSchema = z.object({
  type: z.literal('output_text'),
  text: z.string(),
  annotations: z.array(z.unknown()).optional(),
});

const inputImageContentSchema = z.object({
  type: z.literal('input_image'),
  image_url: z.string().optional(),
  detail: z.enum(['auto', 'low', 'high']).optional(),
});

const inputFileContentSchema = z.object({
  type: z.literal('input_file'),
  filename: z.string().optional(),
  file_data: z.string().optional(),
  file_url: z.string().optional(),
});

const inputVideoContentSchema = z.object({
  type: z.literal('input_video'),
  video_url: z.string(),
});
```

**Problem:** None of the input content schemas include a `cache_control` field. This prevents clients from specifying Anthropic cache controls per content block.

---

### 4. Contrast: Anthropic-Compat Endpoint Works Correctly

**File:** `lib/anthropic-compat/convert-to-aisdk-call-options.ts`  
**Lines:** 65-85

```typescript
  // Add system message if present
  if (request.system) {
    if (typeof request.system === 'string') {
      messages.push({
        role: 'system',
        content: request.system,
      });
    } else {
      // Array of system content blocks
      for (const block of request.system) {
        const cacheControlProviderOptions =
          createProviderOptionsFromCacheControl(block.cache_control);
        messages.push({
          role: 'system',
          content: block.text,
          ...(cacheControlProviderOptions && {
            providerOptions:
              cacheControlProviderOptions as SharedV2ProviderOptions,
          }),
        });
      }
    }
  }
```

**This shows:** Anthropic-compat explicitly maps `cache_control` into per-message `providerOptions`. OpenResponses does not have an equivalent mapping for instructions or message parts.

---

### 5. Tool Conversion Missing cache_control

**File:** `lib/openresponses-compat/convert-to-aisdk-call-options.ts`  
**Lines:** 115-125

```typescript
    ...(tools &&
      tools.length > 0 && {
        tools: tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.parameters,
        })),
        toolChoice: convertToolChoice(request.tool_choice),
      }),
```

**Problem:** Tool mapping ignores any potential `cache_control` and does not attach `providerOptions` to tools. There is no path for tool-level caching even if the provider supports it.

---

## Proposed Fix

### Option A: Minimal Fix (High Value, Low Effort)

Apply top-level `providerOptions.anthropic.cacheControl` to the instructions system message:

```typescript
// Current (lines 82-85):
if (request.instructions) {
  messages.unshift({ role: 'system', content: request.instructions });
}

// Proposed:
if (request.instructions) {
  const anthropicCacheControl = (request.providerOptions?.anthropic as Record<string, unknown>)?.cacheControl;
  messages.unshift({
    role: 'system',
    content: [{
      type: 'text',
      text: request.instructions,
      ...(anthropicCacheControl && {
        providerOptions: { anthropic: { cacheControl: anthropicCacheControl } }
      })
    }]
  });
}
```

This would enable caching of the system prompt (often the largest stable prefix) without schema changes.

### Option B: Full Fix (Per-Message cache_control)

Extend OpenResponses to support per-message caching:

1. **Schema updates** in `openresponses-compat-api-types.ts`:
   ```typescript
   const inputTextContentSchema = z.object({
     type: z.literal('input_text'),
     text: z.string(),
     cache_control: z.object({ type: z.enum(['ephemeral']) }).optional(),
   });
   ```

2. **Conversion updates** in `convert-to-aisdk-call-options.ts`:
   - Map `cache_control` to `providerOptions.anthropic.cacheControl` on each content part
   - Mirror the pattern from `lib/anthropic-compat/convert-to-aisdk-call-options.ts`

3. **Tool schema updates** to allow `cache_control` on tool definitions

---

## Impact Analysis

### Cost Impact

For a 50-turn conversation with:
- 5k token system prompt
- 3k tokens average per turn

**Without caching (current):**
- Each turn pays for full context: 5k + (turn# × 3k) tokens
- Turn 50 pays: 155k input tokens
- Total across all turns: ~3.8M input tokens

**With caching (proposed):**
- System prompt cached after first turn: 5k × 1 + (5k × 0.1 × 49) = ~30k tokens for system prompt
- Savings: ~88% on system prompt alone
- Message history could also be cached with Option B

### Who Is Affected

- All users of OpenResponses endpoint with Claude/Anthropic models
- VS Code extensions using the OpenResponses API
- Any client that can't use Anthropic-compat format directly

---

## Reproduction

```bash
# This request SHOULD enable caching but doesn't:
curl -sS https://gateway.ai.vercel.com/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "instructions": "You are a helpful assistant with extensive knowledge...",
    "input": [{
      "type": "message",
      "role": "user",
      "content": [{
        "type": "input_text",
        "text": "Hello"
      }]
    }],
    "providerOptions": {
      "anthropic": {
        "cacheControl": { "type": "ephemeral" }
      }
    }
  }'
```

**Expected:** `providerOptions.anthropic.cacheControl` applies to system message, enabling Anthropic caching.  
**Actual:** `cacheControl` is passed through at top level but never applied to message parts. Anthropic doesn't see any cache hints.

---

## Workarounds

Currently none available for OpenResponses users. Options:

1. Switch to Anthropic-compat API (`/v1/messages`) - requires significant client changes
2. Accept higher costs until fix is available

---

## Related Files

| File | Purpose |
|------|---------|
| `lib/openresponses-compat/convert-to-aisdk-call-options.ts` | Message conversion (needs fix) |
| `lib/openresponses-compat/openresponses-compat-api-types.ts` | Schema (needs cache_control field) |
| `lib/anthropic-compat/convert-to-aisdk-call-options.ts` | Reference implementation (works correctly) |
| `app/v1/responses/route.ts` | Route handler |
