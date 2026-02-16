/**
 * Agent module - types and registry for agent tracking
 */

export type {
  AgentEntry,
  ContextManagementEdit,
  ContextManagementInfo,
  EstimationState,
  TokenUsage,
} from "./types.js";

export {
  AGENT_CLEANUP_INTERVAL_MS,
  AGENT_DIM_AFTER_REQUESTS,
  AGENT_REMOVE_AFTER_REQUESTS,
} from "./types.js";

export type {
  AgentCompletedEvent,
  AgentContext,
  AgentErroredEvent,
  AgentRegistry,
  AgentRegistryEvent,
  AgentRegistryEventBase,
  AgentRemovedEvent,
  AgentsClearedEvent,
  AgentStartedEvent,
  AgentUpdatedEvent,
  StartAgentParams,
} from "./registry.js";

export { AgentRegistryImpl } from "./registry-impl.js";
