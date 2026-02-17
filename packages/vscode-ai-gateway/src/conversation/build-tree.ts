/**
 * Re-export tree builder from @vercel/conversation.
 *
 * The pure tree logic now lives in the shared package. This file preserves
 * the import path so existing extension code doesn't need to change.
 */

export {
  buildTree,
  groupByUserMessage,
  isActualUserMessage,
  renderTree,
  windowActivityLog,
  WINDOW_SIZE,
} from "@vercel/conversation";

export type { TreeChild, TreeNode, TreeResult } from "@vercel/conversation";
