# OpenResponses Client

A TypeScript client library for the [OpenResponses API](https://www.openresponses.org/).

## ⚠️ IMPORTANT: API Format

This package implements the **OpenResponses wire protocol**, which is:

- **NOT** the OpenAI Chat Completions API
- **NOT** the Vercel AI SDK format
- Based on (but independent from) the OpenAI Responses API

**Always refer to the OpenResponses specification, not OpenAI or Vercel AI SDK documentation.**

## Documentation

- **[OpenResponses Specification](./docs/OPENRESPONSES-SPEC.md)** - Complete protocol documentation
- **[OpenAPI Schema](./openapi.json)** - Machine-readable API specification
- **[Official Reference](https://www.openresponses.org/reference)** - Canonical API reference

## Installation

```bash
pnpm add openresponses-client
```

## Quick Start

```typescript
import { createClient } from "openresponses-client";

const client = createClient({
  // baseUrl must include `/v1` because the client appends `/responses`.
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  apiKey: "your-api-key",
});

// Non-streaming request
const response = await client.createResponse({
  model: "anthropic/claude-sonnet-4.5",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello!" }],
    },
  ],
});

// Streaming request
for await (const event of client.createStreamingResponse({
  model: "anthropic/claude-sonnet-4.5",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello!" }],
    },
  ],
  stream: true,
})) {
  if (event.type === "response.output_text.delta") {
    process.stdout.write(event.delta);
  }
}
```

## Key Concepts

### Input Items

Messages in OpenResponses use the `ItemParam` union type, discriminated by `type`:

```typescript
// User message
{
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'Hello' }]
}

// Assistant message (for conversation history)
{
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Hi there!' }]
}

// Function call (model output, passed back for context)
{
  type: 'function_call',
  call_id: 'call_123',
  name: 'get_weather',
  arguments: '{"location":"NYC"}'
}

// Function result
{
  type: 'function_call_output',
  call_id: 'call_123',
  output: '{"temp": 72}'
}
```

### Content Types

**User/System/Developer messages use INPUT content types:**

- `input_text` - Text content
- `input_image` - Image content
- `input_file` - File content

**Assistant messages use OUTPUT content types:**

- `output_text` - Text content
- `refusal` - Model refusal

### Tools

Tools use a **flat structure** (not nested under a `function` key):

```typescript
const tools = [
  {
    type: "function",
    name: "get_weather",
    description: "Get current weather",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
    },
  },
];
```

## Type Exports

All types are generated from the OpenAPI specification using Kubb:

```typescript
import type {
  // Request/Response
  CreateResponseBody,
  ResponseResource,

  // Items
  ItemParam,
  UserMessageItemParam,
  AssistantMessageItemParam,
  FunctionCallItemParam,
  FunctionCallOutputItemParam,

  // Content
  InputTextContentParam,
  OutputTextContentParam,

  // Tools
  FunctionToolParam,

  // Streaming
  StreamingEvent,
  ResponseCompletedStreamingEvent,
  ResponseOutputTextDeltaStreamingEvent,

  // Usage
  Usage,
} from "openresponses-client";
```

## License

MIT
