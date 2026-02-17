/**
 * @vercel/conversation — Pure conversation model.
 *
 * Types, tree building, and rendering for the conversation domain.
 * No runtime dependencies. Shared between the VS Code extension and CLI.
 */

export type {
  ActivityLogEntry,
  AIResponseEntry,
  AIResponseState,
  CompactionEntry,
  CompactionEvent,
  Conversation,
  ErrorEntry,
  Subagent,
  ToolCallDetail,
  UserMessageEntry,
} from "./types.ts";

export {
  buildTree,
  groupByUserMessage,
  isActualUserMessage,
  renderTree,
  windowActivityLog,
  WINDOW_SIZE,
} from "./build-tree.ts";

export type { TreeChild, TreeNode, TreeResult } from "./build-tree.ts";
