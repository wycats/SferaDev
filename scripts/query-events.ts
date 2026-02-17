#!/usr/bin/env node
/**
 * Shim: forwards to packages/agent-cli/src/query-events.ts
 *
 * This file exists so `node scripts/query-events.ts` continues to work
 * from the workspace root. The real implementation lives in @vercel/agent-cli.
 */
import("../packages/agent-cli/src/query-events.ts");
