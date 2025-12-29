# toolsmesh

A virtual filesystem wrapper for AI SDK tools that enables intelligent tool discovery and execution.

## Features

- **Virtual Filesystem** - Tools represented as TypeScript files with full type information
- **Bash Interface** - `ls`, `cat`, `grep`, `find` for natural tool discovery
- **TypeScript Execution** - Run code that chains multiple tools with validation
- **Context Compaction** - Offload large tool results to the filesystem
- **AI SDK v6 Compatible** - Works with `wrapLanguageModel` middleware pattern

## Quick Start

```typescript
import { wrapLanguageModel } from "ai";
import { createToolsmeshMiddleware } from "toolsmesh";
import { z } from "zod";

const tools = {
  createUser: {
    description: "Create a new user account",
    parameters: z.object({
      name: z.string(),
      email: z.string().email(),
    }),
    execute: async ({ name, email }) => ({ id: crypto.randomUUID(), name, email }),
  },
};

const middleware = createToolsmeshMiddleware({ tools });

const model = wrapLanguageModel({
  model: yourBaseModel,
  middleware,
});
```

The model explores tools using bash commands and executes TypeScript:

```bash
ls /tools                    # List available tools
grep -r "email" /tools       # Search by functionality
cat /tools/createUser.ts     # Read full interface
```

```typescript
const user = await createUser({ name: "Alice", email: "alice@example.com" });
```

## Documentation

For full documentation, API reference, and examples, see the [documentation](https://sferadev.com/docs/packages/toolsmesh).

## License

MIT
