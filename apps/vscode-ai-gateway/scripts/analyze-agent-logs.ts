#!/usr/bin/env node
/// <reference types="node" />
/**
 * Agent Log Analysis Script
 *
 * Parses tree-diagnostics.log and outputs structured analysis for AI review.
 * Correlates with VS Code Copilot Chat logs for unified timeline view.
 *
 * Usage:
 *   node scripts/analyze-agent-logs.ts [workspace-path] [options]
 *
 * Options:
 *   --narrative, -n     Output human-readable timeline instead of JSON
 *   --session-only, -s  Filter VS Code events to session timeframe (±5 min)
 *   --tokens, -t        Show token estimation accuracy analysis (with --narrative)
 *
 * Examples:
 *   node scripts/analyze-agent-logs.ts /path/to/workspace
 *   node scripts/analyze-agent-logs.ts /path/to/workspace --narrative
 *   node scripts/analyze-agent-logs.ts /path/to/workspace --narrative --session-only
 *   node scripts/analyze-agent-logs.ts /path/to/workspace --narrative --tokens
 *
 * Or via npm script:
 *   pnpm run analyze:logs [workspace-path]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Re-declare types inline to make script standalone (no build step required)
interface TreeSnapshot {
  agents: AgentSnapshotEntry[];
  claims: ClaimSnapshotEntry[];
  mainAgentId: string | null;
  activeAgentId: string | null;
}

interface AgentSnapshotEntry {
  id: string;
  name: string;
  isMain: boolean;
  status: string;
  systemPromptHash?: string;
  agentTypeHash?: string;
  conversationHash?: string;
  parentConversationHash?: string;
  inputTokens: number;
  outputTokens: number;
  /** @deprecated Use maxObservedInputTokens - kept for backward compatibility with old logs */
  totalInputTokens?: number;
  /** Maximum observed input tokens (new field name) */
  maxObservedInputTokens?: number;
  totalOutputTokens: number;
  turnCount: number;
  estimatedInputTokens?: number;
}

interface ClaimSnapshotEntry {
  expectedChildAgentName: string;
  parentConversationHash: string;
  parentAgentTypeHash: string;
  expiresIn: number;
}

interface InvariantCheckResult {
  singleMainAgent: boolean;
  mainAgentExists: boolean;
  allChildrenHaveParent: boolean;
  noOrphanChildren: boolean;
  noDuplicateIds: boolean;
  claimsHaveValidParent: boolean;
  noExpiredClaims: boolean;
  violations: string[];
}

interface DiagnosticEvent {
  timestamp: string;
  event: string;
  data: Record<string, unknown>;
  tree: TreeSnapshot;
  treeText: string;
  invariants?: InvariantCheckResult;
  context?: {
    vscodeSessionId?: string;
  };
}

interface VSCodeLogEntry {
  timestamp: string;
  requestId: string;
  status: string;
  model: string;
  durationMs: number;
  context: string;
}

interface LogAnalysis {
  meta: {
    logPath: string;
    eventCount: number;
    timeRange: { start: string; end: string } | null;
    analyzedAt: string;
  };
  summary: {
    uniqueAgents: number;
    mainAgentChanges: number;
    totalTurns: number;
    maxInputTokens: number;
    totalOutputTokens: number;
    claimsCreated: number;
    claimsMatched: number;
    claimsExpired: number;
    invariantViolations: number;
  };
  vscodeCorrelation: {
    logPath: string | null;
    totalRequests: number;
    externalRequests: number;
    subagentRequests: number;
    correlatedEvents: Array<{
      ourTimestamp: string;
      ourEvent: string;
      vscodeRequestId: string;
      vscodeModel: string;
      vscodeContext: string;
      vscodeDurationMs: number;
    }>;
    uncorrelatedVSCodeRequests: Array<{
      timestamp: string;
      requestId: string;
      model: string;
      context: string;
    }>;
  };
  invariants: {
    allPassed: boolean;
    violationEvents: Array<{
      timestamp: string;
      event: string;
      violations: string[];
    }>;
  };
  timeline: Array<{
    timestamp: string;
    event: string;
    agentName?: string;
    isMain?: boolean;
    summary: string;
  }>;
  finalTree: {
    text: string;
    agentCount: number;
    claimCount: number;
    mainAgentId: string | null;
  } | null;
  agents: Array<{
    id: string;
    name: string;
    isMain: boolean;
    turnCount: number;
    maxObservedInputTokens: number;
    totalOutputTokens: number;
    firstSeen: string;
    lastSeen: string;
  }>;
}

// NT-3: Token accuracy analysis interfaces
interface TokenAccuracyEntry {
  agentId: string;
  agentName: string;
  isMain: boolean;
  estimatedTokens: number;
  actualTokens: number;
  ratio: number; // estimated / actual
  errorPercent: number; // (actual - estimated) / actual * 100
  turnCount: number;
}

interface TokenAccuracySummary {
  entries: TokenAccuracyEntry[];
  aggregate: {
    totalEstimated: number;
    totalActual: number;
    meanRatio: number;
    meanErrorPercent: number;
    maxErrorPercent: number;
    agentsWithData: number;
    agentsWithoutEstimate: number;
  };
}

// NT-4: Extract token accuracy data from events
function extractTokenAccuracy(events: DiagnosticEvent[]): TokenAccuracySummary {
  const agentData = new Map<
    string,
    {
      name: string;
      isMain: boolean;
      estimated: number;
      actual: number;
      turnCount: number;
    }
  >();

  // Process events to find estimated and actual tokens per agent
  for (const event of events) {
    if (!event.tree?.agents) continue;

    for (const agent of event.tree.agents) {
      const existing = agentData.get(agent.id);

      // Track the maximum values seen (tokens accumulate/grow)
      const estimated = agent.estimatedInputTokens ?? existing?.estimated ?? 0;
      // Support both old (totalInputTokens) and new (maxObservedInputTokens) field names
      const actual =
        agent.maxObservedInputTokens ?? agent.totalInputTokens ?? 0;

      agentData.set(agent.id, {
        name: agent.name,
        isMain: agent.isMain,
        estimated: Math.max(estimated, existing?.estimated ?? 0),
        actual: Math.max(actual, existing?.actual ?? 0),
        turnCount: Math.max(agent.turnCount, existing?.turnCount ?? 0),
      });
    }
  }

  // Build entries
  const entries: TokenAccuracyEntry[] = [];
  let totalEstimated = 0;
  let totalActual = 0;
  let agentsWithData = 0;
  let agentsWithoutEstimate = 0;

  for (const [id, data] of agentData) {
    if (data.actual === 0) continue; // Skip agents with no actual data

    if (data.estimated === 0) {
      agentsWithoutEstimate++;
      continue;
    }

    const ratio = data.estimated / data.actual;
    const errorPercent = ((data.actual - data.estimated) / data.actual) * 100;

    entries.push({
      agentId: id,
      agentName: data.name,
      isMain: data.isMain,
      estimatedTokens: data.estimated,
      actualTokens: data.actual,
      ratio,
      errorPercent,
      turnCount: data.turnCount,
    });

    totalEstimated += data.estimated;
    totalActual += data.actual;
    agentsWithData++;
  }

  // Calculate aggregates
  const meanRatio =
    entries.length > 0
      ? entries.reduce((sum, e) => sum + e.ratio, 0) / entries.length
      : 0;
  const meanErrorPercent =
    entries.length > 0
      ? entries.reduce((sum, e) => sum + e.errorPercent, 0) / entries.length
      : 0;
  const maxErrorPercent =
    entries.length > 0
      ? Math.max(...entries.map((e) => Math.abs(e.errorPercent)))
      : 0;

  return {
    entries,
    aggregate: {
      totalEstimated,
      totalActual,
      meanRatio,
      meanErrorPercent,
      maxErrorPercent,
      agentsWithData,
      agentsWithoutEstimate,
    },
  };
}

// NT-5: Format token accuracy for narrative output
function formatTokenAccuracy(accuracy: TokenAccuracySummary): string {
  const lines: string[] = [];

  lines.push("--- Token Estimation Accuracy ---");
  lines.push("");

  if (accuracy.entries.length === 0) {
    lines.push(
      "No token estimation data available. Ensure estimatedInputTokens is being captured.",
    );
    if (accuracy.aggregate.agentsWithoutEstimate > 0) {
      lines.push(
        `(${accuracy.aggregate.agentsWithoutEstimate} agents had actual tokens but no estimates)`,
      );
    }
    return lines.join("\n");
  }

  // Aggregate summary
  const agg = accuracy.aggregate;
  lines.push(
    `Aggregate: ${agg.totalEstimated.toLocaleString()} estimated vs ${agg.totalActual.toLocaleString()} actual`,
  );
  lines.push(
    `Mean ratio: ${agg.meanRatio.toFixed(3)} (estimates are ${agg.meanErrorPercent.toFixed(1)}% ${agg.meanErrorPercent > 0 ? "under" : "over"})`,
  );
  lines.push(`Max error: ${agg.maxErrorPercent.toFixed(1)}%`);
  lines.push(
    `Agents: ${agg.agentsWithData} with data, ${agg.agentsWithoutEstimate} without estimates`,
  );
  lines.push("");

  // Per-agent table
  lines.push("Per-Agent Breakdown:");
  lines.push(
    "  Agent ID  | Name                          | Est      | Actual   | Ratio | Error",
  );
  lines.push(
    "  ----------|-------------------------------|----------|----------|-------|-------",
  );

  for (const entry of accuracy.entries) {
    const name = entry.agentName.slice(0, 29).padEnd(29);
    const est = entry.estimatedTokens.toLocaleString().padStart(8);
    const act = entry.actualTokens.toLocaleString().padStart(8);
    const ratio = entry.ratio.toFixed(3).padStart(5);
    const error =
      `${entry.errorPercent >= 0 ? "+" : ""}${entry.errorPercent.toFixed(1)}%`.padStart(
        6,
      );
    const mainTag = entry.isMain ? "*" : " ";
    lines.push(
      `  ${entry.agentId.padEnd(8)}${mainTag} | ${name} | ${est} | ${act} | ${ratio} | ${error}`,
    );
  }

  return lines.join("\n");
}

function parseLogFile(logPath: string): DiagnosticEvent[] {
  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const events: DiagnosticEvent[] = [];

  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as DiagnosticEvent);
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

function findVSCodeLogPath(): string | null {
  const logsRoot = path.join(os.homedir(), ".config", "Code", "logs");

  if (!fs.existsSync(logsRoot)) {
    return null;
  }

  const sessionDirs = fs
    .readdirSync(logsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  if (sessionDirs.length === 0) {
    return null;
  }

  // Search through ALL sessions to find the most recently modified Copilot Chat log
  let bestPath: string | null = null;
  let bestMtime = 0;

  for (const sessionDir of sessionDirs) {
    const sessionPath = path.join(logsRoot, sessionDir);

    let windowDirs: string[];
    try {
      windowDirs = fs
        .readdirSync(sessionPath, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith("window"),
        )
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const windowDir of windowDirs) {
      const candidate = path.join(
        sessionPath,
        windowDir,
        "exthost",
        "GitHub.copilot-chat",
        "GitHub Copilot Chat.log",
      );
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const stats = fs.statSync(candidate);
      if (stats.mtimeMs > bestMtime) {
        bestMtime = stats.mtimeMs;
        bestPath = candidate;
      }
    }
  }

  return bestPath;
}

function parseVSCodeLogs(logPath: string): VSCodeLogEntry[] {
  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n");
  const entries: VSCodeLogEntry[] = [];

  const logRegex =
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[[^\]]+\] (ccreq:[^\s]+) \| ([^|]+) \| ([^|]+) \| (\d+)ms \| (\[[^\]]+\])/;

  for (const line of lines) {
    if (!line.includes("ccreq:")) {
      continue;
    }
    const match = line.match(logRegex);
    if (!match) {
      continue;
    }
    const [, timestamp, requestId, status, model, durationMs, context] = match;
    entries.push({
      timestamp,
      requestId,
      status: status.trim(),
      model: model.trim(),
      durationMs: Number(durationMs),
      context: context.trim(),
    });
  }

  return entries;
}

function parseTimestampToMs(timestamp: string): number {
  const direct = Date.parse(timestamp);
  if (!Number.isNaN(direct)) {
    return direct;
  }
  const normalized = timestamp.replace(" ", "T");
  return Date.parse(normalized);
}

function buildVSCodeCorrelation(
  events: DiagnosticEvent[],
  vscodeLogs: VSCodeLogEntry[],
  logPath: string | null,
): LogAnalysis["vscodeCorrelation"] {
  if (!logPath) {
    return {
      logPath: null,
      totalRequests: 0,
      externalRequests: 0,
      subagentRequests: 0,
      correlatedEvents: [],
      uncorrelatedVSCodeRequests: [],
    };
  }

  const externalContexts = new Set([
    "[panel/editAgent-external]",
    "[tool/runSubagent-external]",
  ]);
  const subagentContexts = new Set([
    "[tool/runSubagent]",
    "[tool/runSubagent-external]",
  ]);

  const totalRequests = vscodeLogs.length;
  const externalRequests = vscodeLogs.filter((entry) =>
    externalContexts.has(entry.context),
  ).length;
  const subagentRequests = vscodeLogs.filter((entry) =>
    subagentContexts.has(entry.context),
  ).length;

  const relevantEvents = new Set([
    "AGENT_STARTED",
    "AGENT_RESUMED",
    "AGENT_COMPLETED",
  ]);

  const usedIndices = new Set<number>();
  const correlatedEvents: LogAnalysis["vscodeCorrelation"]["correlatedEvents"] =
    [];

  for (const event of events) {
    if (!relevantEvents.has(event.event)) {
      continue;
    }
    const eventMs = parseTimestampToMs(event.timestamp);
    if (Number.isNaN(eventMs)) {
      continue;
    }

    let bestIndex: number | null = null;
    let bestDiff = Infinity;

    for (let i = 0; i < vscodeLogs.length; i++) {
      if (usedIndices.has(i)) {
        continue;
      }
      const candidate = vscodeLogs[i];
      const candidateMs = parseTimestampToMs(candidate.timestamp);
      if (Number.isNaN(candidateMs)) {
        continue;
      }
      const diff = Math.abs(candidateMs - eventMs);
      if (diff <= 2000 && diff < bestDiff) {
        bestDiff = diff;
        bestIndex = i;
      }
    }

    if (bestIndex !== null) {
      usedIndices.add(bestIndex);
      const match = vscodeLogs[bestIndex];
      correlatedEvents.push({
        ourTimestamp: event.timestamp,
        ourEvent: event.event,
        vscodeRequestId: match.requestId,
        vscodeModel: match.model,
        vscodeContext: match.context,
        vscodeDurationMs: match.durationMs,
      });
    }
  }

  const uncorrelatedVSCodeRequests = vscodeLogs
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !usedIndices.has(index))
    .map(({ entry }) => ({
      timestamp: entry.timestamp,
      requestId: entry.requestId,
      model: entry.model,
      context: entry.context,
    }));

  return {
    logPath,
    totalRequests,
    externalRequests,
    subagentRequests,
    correlatedEvents,
    uncorrelatedVSCodeRequests,
  };
}

function analyzeEvents(
  events: DiagnosticEvent[],
  logPath: string,
  vscodeLogPath: string | null,
  vscodeLogs: VSCodeLogEntry[],
): LogAnalysis {
  const agentStats = new Map<
    string,
    {
      name: string;
      isMain: boolean;
      turnCount: number;
      maxObservedInputTokens: number;
      totalOutputTokens: number;
      firstSeen: string;
      lastSeen: string;
    }
  >();

  let mainAgentChanges = 0;
  let lastMainAgentId: string | null = null;
  let claimsCreated = 0;
  let claimsMatched = 0;
  let claimsExpired = 0;

  const violationEvents: LogAnalysis["invariants"]["violationEvents"] = [];
  const timeline: LogAnalysis["timeline"] = [];
  let finalTree: LogAnalysis["finalTree"] = null;

  for (const event of events) {
    // Track invariant violations
    const violations = event.invariants?.violations;
    if (violations && violations.length > 0) {
      violationEvents.push({
        timestamp: event.timestamp,
        event: event.event,
        violations,
      });
    }

    // Track main agent changes
    if (event.tree?.mainAgentId && event.tree.mainAgentId !== lastMainAgentId) {
      mainAgentChanges++;
      lastMainAgentId = event.tree.mainAgentId;
    }

    // Track claims
    if (event.event === "CLAIM_CREATED") claimsCreated++;
    if (event.event === "CLAIM_MATCHED") claimsMatched++;
    if (event.event === "CLAIM_EXPIRED") claimsExpired++;

    // Track agents from tree snapshots
    if (event.tree?.agents) {
      for (const agent of event.tree.agents) {
        // Support both old (totalInputTokens) and new (maxObservedInputTokens) field names
        const inputTokens =
          agent.maxObservedInputTokens ?? agent.totalInputTokens ?? 0;
        const existing = agentStats.get(agent.id);
        if (existing) {
          existing.lastSeen = event.timestamp;
          existing.turnCount = agent.turnCount;
          existing.maxObservedInputTokens = inputTokens;
          existing.totalOutputTokens = agent.totalOutputTokens;
        } else {
          agentStats.set(agent.id, {
            name: agent.name,
            isMain: agent.isMain,
            turnCount: agent.turnCount,
            maxObservedInputTokens: inputTokens,
            totalOutputTokens: agent.totalOutputTokens,
            firstSeen: event.timestamp,
            lastSeen: event.timestamp,
          });
        }
      }
    }

    // Build timeline entry
    const agentName = event.data?.name as string | undefined;
    const isMain = event.data?.isMain as boolean | undefined;
    let summary = event.event;

    if (event.event === "AGENT_STARTED" || event.event === "AGENT_RESUMED") {
      summary = `${event.event}: ${agentName ?? "unknown"}${isMain ? " (main)" : ""}`;
    } else if (event.event === "AGENT_COMPLETED") {
      // Support both old and new field names in event data
      const tokens = (event.data?.maxObservedInputTokens ??
        event.data?.totalInputTokens) as number | undefined;
      summary = `${event.event}: ${agentName ?? "unknown"} (${tokens ?? 0} tokens)`;
    } else if (event.event === "CLAIM_CREATED") {
      const childName = event.data?.expectedChildAgentName as
        | string
        | undefined;
      summary = `${event.event}: expecting "${childName}"`;
    } else if (event.event === "CLAIM_MATCHED") {
      const childName = event.data?.matchedChildName as string | undefined;
      summary = `${event.event}: "${childName}"`;
    } else if (event.event === "TOOL_CALL_DETECTED") {
      const toolName = event.data?.toolName as string | undefined;
      const extractedName = event.data?.extractedName as string | undefined;
      const argKeys = event.data?.argKeys as string[] | undefined;
      const rawArgs = event.data?.rawArgs as
        | Record<string, unknown>
        | undefined;
      summary = `${event.event}: ${toolName} → "${extractedName}" (keys: ${argKeys?.join(", ") ?? "none"})`;
      if (rawArgs) {
        summary += ` | args: ${JSON.stringify(rawArgs)}`;
      }
    }

    const violationsForSummary = event.invariants?.violations;
    if (violationsForSummary && violationsForSummary.length > 0) {
      summary += ` ⚠️ ${violationsForSummary.length} violation(s)`;
    }

    timeline.push({
      timestamp: event.timestamp,
      event: event.event,
      agentName,
      isMain,
      summary,
    });

    // Keep final tree
    if (event.tree) {
      finalTree = {
        text: event.treeText,
        agentCount: event.tree.agents.length,
        claimCount: event.tree.claims.length,
        mainAgentId: event.tree.mainAgentId,
      };
    }
  }

  // Calculate totals
  let totalTurns = 0;
  let maxInputTokens = 0;
  let totalOutputTokens = 0;

  for (const agent of agentStats.values()) {
    totalTurns += agent.turnCount;
    maxInputTokens = Math.max(maxInputTokens, agent.maxObservedInputTokens);
    totalOutputTokens += agent.totalOutputTokens;
  }

  return {
    meta: {
      logPath,
      eventCount: events.length,
      timeRange:
        events.length > 0
          ? {
              start: events[0].timestamp,
              end: events[events.length - 1].timestamp,
            }
          : null,
      analyzedAt: new Date().toISOString(),
    },
    summary: {
      uniqueAgents: agentStats.size,
      mainAgentChanges,
      totalTurns,
      maxInputTokens,
      totalOutputTokens,
      claimsCreated,
      claimsMatched,
      claimsExpired,
      invariantViolations: violationEvents.length,
    },
    vscodeCorrelation: buildVSCodeCorrelation(
      events,
      vscodeLogs,
      vscodeLogPath,
    ),
    invariants: {
      allPassed: violationEvents.length === 0,
      violationEvents,
    },
    timeline,
    finalTree,
    agents: Array.from(agentStats.entries()).map(([id, stats]) => ({
      id,
      ...stats,
    })),
  };
}

// Unified timeline event for narrative output
interface UnifiedEvent {
  timestampMs: number;
  timestamp: string;
  source: "our" | "vscode";
  // Our event fields
  ourEvent?: string;
  agentName?: string;
  isMain?: boolean;
  violations?: string[];
  // VS Code event fields
  vscodeRequestId?: string;
  vscodeModel?: string;
  vscodeContext?: string;
  vscodeDurationMs?: number;
  // Correlation
  correlated?: boolean;
}

function buildUnifiedTimeline(
  events: DiagnosticEvent[],
  vscodeLogs: VSCodeLogEntry[],
  correlatedSet: Set<string>,
  sessionOnly: boolean,
): UnifiedEvent[] {
  const unified: UnifiedEvent[] = [];

  // Get session time bounds from our events
  let sessionStart = Infinity;
  let sessionEnd = 0;
  for (const event of events) {
    const ts = parseTimestampToMs(event.timestamp);
    if (ts < sessionStart) sessionStart = ts;
    if (ts > sessionEnd) sessionEnd = ts;
  }
  // Add 5 minute buffer on each side
  const bufferMs = 5 * 60 * 1000;
  sessionStart -= bufferMs;
  sessionEnd += bufferMs;

  // Add our events
  for (const event of events) {
    const agentId = event.data?.agentId as string | undefined;
    const canonicalAgentId = event.data?.canonicalAgentId as string | undefined;
    const agent =
      (agentId ? event.tree.agents.find((a) => a.id === agentId) : undefined) ??
      (canonicalAgentId
        ? event.tree.agents.find((a) => a.id === canonicalAgentId)
        : undefined) ??
      event.tree.agents.find((a) => a.id === event.tree.mainAgentId);
    unified.push({
      timestampMs: parseTimestampToMs(event.timestamp),
      timestamp: event.timestamp,
      source: "our",
      ourEvent: event.event,
      agentName: agent?.name || (event.data?.agentName as string),
      isMain: agent?.isMain,
      violations: event.invariants?.violations,
    });
  }

  // Add VS Code events (only uncorrelated ones, correlated are shown inline)
  for (const entry of vscodeLogs) {
    if (correlatedSet.has(entry.requestId)) {
      continue; // Skip correlated - they'll be shown with our events
    }
    const entryTs = parseTimestampToMs(entry.timestamp);
    // Filter to session timeframe if requested
    if (sessionOnly && (entryTs < sessionStart || entryTs > sessionEnd)) {
      continue;
    }
    unified.push({
      timestampMs: entryTs,
      timestamp: entry.timestamp,
      source: "vscode",
      vscodeRequestId: entry.requestId,
      vscodeModel: entry.model,
      vscodeContext: entry.context,
      vscodeDurationMs: entry.durationMs,
      correlated: false,
    });
  }

  // Sort by timestamp
  unified.sort((a, b) => a.timestampMs - b.timestampMs);

  return unified;
}

function formatTime(timestamp: string): string {
  // Normalize all timestamps to local time for consistent display
  const ms = parseTimestampToMs(timestamp);
  const date = new Date(ms);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  const millis = date.getMilliseconds().toString().padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function formatNarrative(
  analysis: LogAnalysis,
  events: DiagnosticEvent[],
  vscodeLogs: VSCodeLogEntry[],
  sessionOnly: boolean,
  showTokens: boolean,
): string {
  const lines: string[] = [];

  // Header
  lines.push("=== Agent Tree Analysis: Narrative Timeline ===");
  lines.push("");

  if (analysis.meta.timeRange) {
    const startLocal = formatTime(analysis.meta.timeRange.start);
    const endLocal = formatTime(analysis.meta.timeRange.end);
    lines.push(`Session: ${startLocal} to ${endLocal} (local time)`);
  }

  lines.push(
    `Agents: ${analysis.summary.uniqueAgents} unique | ` +
      `Main changes: ${analysis.summary.mainAgentChanges} | ` +
      `Violations: ${analysis.summary.invariantViolations}`,
  );

  lines.push(
    `VS Code: ${analysis.vscodeCorrelation.totalRequests} total requests | ` +
      `${analysis.vscodeCorrelation.externalRequests} external | ` +
      `${analysis.vscodeCorrelation.subagentRequests} subagent`,
  );

  lines.push("");
  lines.push("--- Timeline ---");
  lines.push("");

  // Build correlation lookup: our timestamp -> VS Code entry
  const correlationMap = new Map<
    string,
    (typeof analysis.vscodeCorrelation.correlatedEvents)[0]
  >();
  const correlatedRequestIds = new Set<string>();
  for (const corr of analysis.vscodeCorrelation.correlatedEvents) {
    correlationMap.set(corr.ourTimestamp, corr);
    correlatedRequestIds.add(corr.vscodeRequestId);
  }

  // Build unified timeline
  const unified = buildUnifiedTimeline(
    events,
    vscodeLogs,
    correlatedRequestIds,
    sessionOnly,
  );

  for (const event of unified) {
    const time = formatTime(event.timestamp);

    if (event.source === "our") {
      // Our event
      let line = `${time} [${event.ourEvent}]`;

      if (event.agentName) {
        line += ` ${event.agentName}`;
        if (event.isMain) {
          line += " (main)";
        }
      }

      // Check for claim info
      if (event.ourEvent === "CLAIM_CREATED") {
        const diagEvent = events.find((e) => e.timestamp === event.timestamp);
        if (diagEvent?.data?.expectedChildAgentName) {
          line += ` expecting "${diagEvent.data.expectedChildAgentName}"`;
        }
      }

      if (event.violations && event.violations.length > 0) {
        line += ` ⚠️ ${event.violations.length} violation(s)`;
      }

      lines.push(line);

      // Check for correlated VS Code event
      const corr = correlationMap.get(event.timestamp);
      if (corr) {
        lines.push(
          `             └─ VS Code: ${corr.vscodeRequestId} | ${corr.vscodeDurationMs}ms | ${corr.vscodeContext}`,
        );
      }
    } else {
      // VS Code-only event (not correlated with our events)
      const isBuiltIn =
        event.vscodeContext?.includes("[tool/runSubagent]") &&
        !event.vscodeContext?.includes("-external");
      const isSubagent = event.vscodeContext?.includes("runSubagent");

      let line = `${time} [VS Code]`;
      line += ` ${event.vscodeModel}`;
      line += ` | ${event.vscodeContext}`;

      if (isBuiltIn) {
        line += " ← NOT TRACKED (built-in model)";
      } else if (isSubagent) {
        line += " ← subagent";
      }

      lines.push(line);
      lines.push(
        `             └─ ${event.vscodeRequestId} | ${event.vscodeDurationMs}ms`,
      );
    }
  }

  // Final tree state
  if (analysis.finalTree) {
    lines.push("");
    lines.push("--- Final Tree State ---");
    lines.push("");
    lines.push(analysis.finalTree.text);
    lines.push(
      `Agents: ${analysis.finalTree.agentCount} | Claims: ${analysis.finalTree.claimCount}`,
    );
  }

  // Agent summary
  if (analysis.agents.length > 0) {
    lines.push("");
    lines.push("--- Agent Summary ---");
    lines.push("");
    for (const agent of analysis.agents) {
      const mainTag = agent.isMain ? " (main)" : "";
      lines.push(
        `${agent.id}: ${agent.name}${mainTag} | ${agent.turnCount} turns | ${agent.maxObservedInputTokens}→${agent.totalOutputTokens} tokens`,
      );
    }
  }

  // Token accuracy analysis (when --tokens flag is set)
  if (showTokens) {
    const tokenAccuracy = extractTokenAccuracy(events);
    lines.push("");
    lines.push(formatTokenAccuracy(tokenAccuracy));
  }

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);

  // Parse flags
  const narrativeFlag =
    args.includes("--format=narrative") ||
    args.includes("--narrative") ||
    args.includes("-n");
  const sessionOnlyFlag =
    args.includes("--session-only") || args.includes("-s");
  const tokensFlag = args.includes("--tokens") || args.includes("-t");
  const filteredArgs = args.filter(
    (a) =>
      !a.startsWith("--format=") &&
      a !== "--narrative" &&
      a !== "-n" &&
      a !== "--session-only" &&
      a !== "-s" &&
      a !== "--tokens" &&
      a !== "-t",
  );

  const workspacePath = filteredArgs[0] || process.cwd();
  const logPath = path.join(workspacePath, ".logs", "tree-diagnostics.log");

  if (!fs.existsSync(logPath)) {
    console.error(
      JSON.stringify({
        error: `Log file not found: ${logPath}`,
        hint: "Specify workspace path as argument or run from workspace root",
      }),
    );
    process.exit(1);
  }

  const events = parseLogFile(logPath);
  const vscodeLogPath = findVSCodeLogPath();
  const vscodeLogs = vscodeLogPath ? parseVSCodeLogs(vscodeLogPath) : [];
  const analysis = analyzeEvents(events, logPath, vscodeLogPath, vscodeLogs);

  if (narrativeFlag) {
    console.log(
      formatNarrative(
        analysis,
        events,
        vscodeLogs,
        sessionOnlyFlag,
        tokensFlag,
      ),
    );
  } else if (tokensFlag) {
    // Token-only mode (without narrative)
    const tokenAccuracy = extractTokenAccuracy(events);
    console.log(formatTokenAccuracy(tokenAccuracy));
  } else {
    console.log(JSON.stringify(analysis, null, 2));
  }
}

main();
