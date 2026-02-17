#!/usr/bin/env node
/**
 * Event Stream Query Tool
 *
 * Structured query interface for the unified events.jsonl log.
 * Designed for agent use: answers questions about what happened,
 * traces causality chains, and summarizes sessions.
 *
 * Usage:
 *   node packages/agent-cli/src/query-events.ts <command> [options]
 *
 * Commands:
 *   perception                           What the user sees right now (start here)
 *   tail [--count N]                    Last N events (default 20)
 *   session                             Session overview (requests, tokens, errors)
 *   request <chatId>                    All events for a specific request
 *   trace <chatId>                      Causality chain: what did this request cause?
 *   errors                              All error events and agent.errored
 *   conversations                       List conversations with request counts
 *   conversation <id>                   Conversation snapshot + activity log
 *   tree [--at <eventId>]               Reconstructed agent tree
 *   entry <convId> <seq>                Details of a specific activity log entry
 *   search <text>                       Full-text search across event JSON
 *   kinds                               Count events by kind
 *
 * Options:
 *   --log-dir <path>                    Log directory (default: .logs)
 *   --investigation <name>              Investigation name (auto-detected if omitted)
 *   --since <ISO|relative>              Filter events after this time
 *   --until <ISO|relative>              Filter events before this time
 *   --kind <kind>                       Filter by event kind
 *   --conversation <id>                 Filter by conversationId
 *   --json                              Output raw JSON instead of formatted text
 *   --full                              Force reading the entire file (slow for large logs)
 *   --tail-bytes <N>                    Bytes to read from end of file (default: 50MB)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirrors investigation-events.ts without importing extension code)
// ─────────────────────────────────────────────────────────────────────────────

interface EventBase {
  kind: string;
  eventId: string;
  ts: string;
  sessionId: string;
  conversationId: string;
  chatId: string;
  parentChatId?: string | null;
  agentTypeHash?: string | null;
  causedByChatId?: string | null;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stream-parse a JSONL file line by line.
 *
 * Uses readline to avoid loading the entire file into a single string,
 * which fails for files > ~512MB (V8 string length limit).
 */
async function loadEvents(filePath: string): Promise<EventBase[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const events: EventBase[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as EventBase);
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

/**
 * Read only the last N bytes of a file and parse JSONL lines from it.
 *
 * This is much faster than streaming the entire file when you only need
 * recent events. Reads a chunk from the end, finds complete lines, and
 * parses them. If the chunk doesn't contain enough events, falls back
 * to full streaming.
 */
async function loadRecentEvents(
  filePath: string,
  tailBytes: number,
): Promise<EventBase[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= tailBytes) {
    // File is small enough to read entirely
    return loadEvents(filePath);
  }

  const events: EventBase[] = [];
  const start = stat.size - tailBytes;

  // Read the tail chunk
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(tailBytes);
  fs.readSync(fd, buffer, 0, tailBytes, start);
  fs.closeSync(fd);

  const content = buffer.toString("utf8");
  const lines = content.split("\n");

  // Skip the first line (likely partial)
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as EventBase);
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

interface FilterOptions {
  since?: string | undefined;
  until?: string | undefined;
  kind?: string | undefined;
  conversation?: string | undefined;
}

function applyFilters(events: EventBase[], opts: FilterOptions): EventBase[] {
  let result = events;

  if (opts.since) {
    const since = parseTime(opts.since);
    result = result.filter((e) => new Date(e.ts).getTime() >= since);
  }
  if (opts.until) {
    const until = parseTime(opts.until);
    result = result.filter((e) => new Date(e.ts).getTime() <= until);
  }
  if (opts.kind) {
    result = result.filter((e) => e.kind === opts.kind);
  }
  if (opts.conversation) {
    result = result.filter((e) => e.conversationId === opts.conversation);
  }

  return result;
}

function parseTime(value: string): number {
  // Support relative times like "5m", "1h", "30s"
  const relativeMatch = /^(\d+)([smh])$/.exec(value);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1]!, 10);
    const unit = relativeMatch[2]!;
    const ms =
      unit === "s"
        ? amount * 1000
        : unit === "m"
          ? amount * 60000
          : amount * 3600000;
    return Date.now() - ms;
  }
  // Otherwise parse as ISO date
  return new Date(value).getTime();
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(ts: string): string {
  const d = new Date(ts);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatEvent(e: EventBase): string {
  const time = formatTime(e.ts);
  const id = e.eventId.slice(-8);

  switch (e.kind) {
    case "session.start":
      return `${time} [${id}] SESSION START  v${(e as any).extensionVersion}`;

    case "session.end":
      return `${time} [${id}] SESSION END`;

    case "agent.started": {
      const a = e as any;
      const main = a.isMain ? " (main)" : "";
      const resume = a.isResume ? " [resume]" : "";
      return `${time} [${id}] AGENT START    ${a.agentId?.slice(-12)}${main}${resume}  chat=${e.chatId?.slice(-12)}`;
    }

    case "agent.completed": {
      const a = e as any;
      const inp = a.usage?.inputTokens ?? "?";
      const out = a.usage?.outputTokens ?? "?";
      const summ = a.summarizationDetected ? " ⚠️SUMMARIZED" : "";
      return `${time} [${id}] AGENT DONE     ${a.agentId?.slice(-12)}  ${inp}in/${out}out  turns=${a.turnCount}${summ}`;
    }

    case "agent.errored": {
      const a = e as any;
      return `${time} [${id}] AGENT ERROR    ${a.agentId?.slice(-12)}  chat=${e.chatId?.slice(-12)}`;
    }

    case "agent.updated": {
      const a = e as any;
      return `${time} [${id}] AGENT UPDATE   ${a.agentId?.slice(-12)}  type=${a.updateType}`;
    }

    case "agent.removed": {
      const a = e as any;
      return `${time} [${id}] AGENT REMOVED  ${a.agentId?.slice(-12)}  reason=${a.reason}`;
    }

    case "request.index": {
      const entry = (e as any).entry;
      const status = entry?.status ?? "?";
      const model = entry?.model ?? "?";
      const inp =
        entry?.actualInputTokens ?? entry?.estimatedInputTokens ?? "?";
      const out = entry?.actualOutputTokens ?? "?";
      const dur = entry?.durationMs ? `${entry.durationMs}ms` : "?";
      const summ = entry?.isSummarization ? " [SUMMARIZATION]" : "";
      return `${time} [${id}] REQUEST INDEX  ${status}  ${model}  ${inp}in/${out}out  ${dur}${summ}`;
    }

    case "request.message-summary":
      return `${time} [${id}] REQUEST MSGS   chat=${e.chatId?.slice(-12)}`;

    case "request.full":
      return `${time} [${id}] REQUEST FULL   chat=${e.chatId?.slice(-12)}`;

    case "request.sse":
      return `${time} [${id}] SSE EVENT      chat=${e.chatId?.slice(-12)}  type=${(e as any).entry?.type ?? "?"}`;

    case "tree.change": {
      const tc = e as any;
      const opType = tc.op?.type ?? "unknown";
      const caused = tc.causedByChatId
        ? `  caused-by=${tc.causedByChatId.slice(-12)}`
        : "";
      return `${time} [${id}] TREE CHANGE    ${opType}${caused}`;
    }

    case "tree.snapshot": {
      const ts = e as any;
      const count = ts.conversations?.length ?? 0;
      return `${time} [${id}] TREE SNAPSHOT  trigger=${ts.trigger}  conversations=${count}`;
    }

    default:
      return `${time} [${id}] ${e.kind.toUpperCase().padEnd(14)} chat=${e.chatId?.slice(-12)}`;
  }
}

function printEvents(events: EventBase[], json: boolean): void {
  if (json) {
    for (const e of events) {
      console.log(JSON.stringify(e));
    }
  } else {
    for (const e of events) {
      console.log(formatEvent(e));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree Reconstruction
// ─────────────────────────────────────────────────────────────────────────────

function formatTokenValue(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "?";
  if (value < 1000) return String(value);
  const rounded = (value / 1000).toFixed(1).replace(/\.0$/, "");
  return `${rounded}k`;
}

function formatTokenDelta(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "";
  return `+${formatTokenValue(value)}`;
}

function formatPercentage(
  input: number | undefined,
  maxInput: number | undefined,
): string {
  if (input === undefined || maxInput === undefined || maxInput === 0)
    return "?%";
  return `${Math.round((input / maxInput) * 100)}%`;
}

function matchById(value: string | undefined, target: string): boolean {
  if (!value) return false;
  return value === target || value.startsWith(target) || value.endsWith(target);
}

function reconstructTree(events: EventBase[], atEventId?: string): any[] {
  let scoped = events;

  if (atEventId) {
    let index = -1;
    for (let i = 0; i < events.length; i++) {
      if (matchById(events[i]?.eventId, atEventId)) {
        index = i;
      }
    }
    if (index >= 0) {
      scoped = events.slice(0, index + 1);
    }
  }

  let snapshotIndex = -1;
  for (let i = scoped.length - 1; i >= 0; i--) {
    if (scoped[i]?.kind === "tree.snapshot") {
      snapshotIndex = i;
      break;
    }
  }

  const convMap = new Map<string, any>();
  if (snapshotIndex >= 0) {
    const snapshot = scoped[snapshotIndex] as any;
    const conversations = snapshot.conversations ?? [];
    for (const conv of conversations) {
      convMap.set(conv.id, JSON.parse(JSON.stringify(conv)));
    }
  }

  const startIndex = snapshotIndex >= 0 ? snapshotIndex + 1 : 0;
  for (let i = startIndex; i < scoped.length; i++) {
    const e = scoped[i];
    if (e?.kind !== "tree.change") continue;
    const op = (e as any).op as any;
    if (!op?.type) continue;

    switch (op.type) {
      case "conversation-added": {
        const conv = op.conversation;
        if (conv?.id) convMap.set(conv.id, JSON.parse(JSON.stringify(conv)));
        break;
      }
      case "conversation-removed": {
        convMap.delete(op.conversationId);
        break;
      }
      case "conversation-forked": {
        const conv = convMap.get(op.conversationId);
        if (conv) {
          conv.forkedFrom = {
            conversationId: op.forkedFrom,
            atSequence: op.atSequence,
          };
        }
        break;
      }
      case "status-changed": {
        const conv = convMap.get(op.conversationId);
        if (conv) conv.status = op.status;
        break;
      }
      case "title-changed": {
        const conv = convMap.get(op.conversationId);
        if (conv) conv.title = op.title;
        break;
      }
      case "tokens-updated": {
        const conv = convMap.get(op.conversationId);
        if (conv) conv.tokens = op.tokens;
        break;
      }
      case "user-message-added":
      case "ai-response-added":
      case "compaction-added":
      case "error-added": {
        const conv = convMap.get(op.conversationId);
        if (conv) {
          conv.activityLog = conv.activityLog ?? [];
          conv.activityLog.push(op.entry);
        }
        break;
      }
      case "user-message-updated": {
        const conv = convMap.get(op.conversationId);
        if (conv?.activityLog) {
          const entry = conv.activityLog.find(
            (item: any) =>
              item.type === "user-message" &&
              item.sequenceNumber === op.sequenceNumber,
          );
          if (entry) Object.assign(entry, op.fields ?? {});
        }
        break;
      }
      case "ai-response-updated": {
        const conv = convMap.get(op.conversationId);
        if (conv?.activityLog) {
          const entry = conv.activityLog.find(
            (item: any) =>
              item.type === "ai-response" &&
              item.sequenceNumber === op.sequenceNumber,
          );
          if (entry) Object.assign(entry, op.fields ?? {});
        }
        break;
      }
      case "ai-response-characterized": {
        const conv = convMap.get(op.conversationId);
        if (conv?.activityLog) {
          const entry = conv.activityLog.find(
            (item: any) =>
              item.type === "ai-response" &&
              item.sequenceNumber === op.sequenceNumber,
          );
          if (entry) entry.characterization = op.characterization;
        }
        break;
      }
      case "subagent-added": {
        const conv = convMap.get(op.conversationId);
        if (conv) {
          conv.subagents = conv.subagents ?? [];
          conv.subagents.push(op.subagent);
        }
        break;
      }
      default:
        break;
    }
  }

  return [...convMap.values()];
}

function statusIndicator(status: string | undefined): string {
  switch (status) {
    case "idle":
      return "▽";
    case "archived":
      return "△";
    case "active":
    default:
      return "▼";
  }
}

function formatActivityEntry(entry: any): string {
  if (!entry || !entry.type) return "(unknown entry)";
  if (entry.type === "user-message") {
    const preview = entry.preview ? `"${entry.preview}"` : "(user message)";
    const seq = entry.sequenceNumber ?? "?";
    const tokens = formatTokenDelta(entry.tokenContribution);
    return `${preview}  #${seq}${tokens ? ` · ${tokens}` : ""}`;
  }
  if (entry.type === "ai-response") {
    const label = entry.characterization ?? "(AI response)";
    const seq = entry.sequenceNumber ?? "?";
    const tools = entry.toolsUsed?.length ? entry.toolsUsed.join(", ") : "";
    const tokens = formatTokenDelta(entry.tokenContribution);
    const streaming = entry.state === "streaming" ? " (streaming...)" : "";
    const parts = [`#${seq}`];
    if (tools) parts.push(tools);
    if (tokens) parts.push(tokens);
    return `${label}  ${parts.join(" · ")}${streaming}`;
  }
  if (entry.type === "compaction") {
    const freed = entry.freedTokens ?? 0;
    return `[compaction: freed ${freed} tokens]`;
  }
  if (entry.type === "error") {
    return `⚠ ${entry.message ?? "(error)"}`;
  }
  return "(unknown entry)";
}

function formatSubagentLine(subagent: any): string {
  const name = subagent.name ?? "(subagent)";
  const status = subagent.status ?? "?";
  const input = formatTokenValue(subagent.tokens?.input);
  const output = formatTokenValue(subagent.tokens?.output);
  const id = subagent.id ?? "";
  const idPart = id ? `  ${id}` : "";
  return `${name}  ${status}  ${input}/${output}${idPart}`;
}

function printTreeLine(prefix: string, isLast: boolean, line: string): void {
  const branch = isLast ? "└─ " : "├─ ";
  console.log(`${prefix}${branch}${line}`);
}

function printSubagent(subagent: any, prefix: string, isLast: boolean): void {
  printTreeLine(prefix, isLast, formatSubagentLine(subagent));
  const children = subagent.children ?? [];
  const nextPrefix = prefix + (isLast ? "  " : "│ ");
  for (let i = 0; i < children.length; i++) {
    printSubagent(children[i], nextPrefix, i === children.length - 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

function cmdTail(events: EventBase[], count: number, json: boolean): void {
  const tail = events.slice(-count);
  if (tail.length === 0) {
    console.log("No events found.");
    return;
  }
  console.log(`--- Last ${tail.length} of ${events.length} events ---\n`);
  printEvents(tail, json);
}

function cmdSession(events: EventBase[]): void {
  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  const starts = events.filter((e) => e.kind === "agent.started");
  const completions = events.filter((e) => e.kind === "agent.completed");
  const errors = events.filter((e) => e.kind === "agent.errored");
  const indices = events.filter((e) => e.kind === "request.index");
  const treeChanges = events.filter((e) => e.kind === "tree.change");
  const conversations = new Set(events.map((e) => e.conversationId));
  const sessions = new Set(events.map((e) => e.sessionId));

  // Token totals from request.index events
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let summarizations = 0;
  for (const e of indices) {
    const entry = (e as any).entry;
    if (entry) {
      totalInput += entry.actualInputTokens ?? entry.estimatedInputTokens ?? 0;
      totalOutput += entry.actualOutputTokens ?? 0;
      totalCached += entry.cachedTokens ?? 0;
      if (entry.isSummarization) summarizations++;
    }
  }

  const first = events[0]!;
  const last = events[events.length - 1]!;
  const durationMs = new Date(last.ts).getTime() - new Date(first.ts).getTime();
  const durationMin = (durationMs / 60000).toFixed(1);

  console.log("=== Session Overview ===\n");
  console.log(`Sessions:       ${sessions.size}`);
  console.log(`Conversations:  ${conversations.size}`);
  console.log(`Duration:       ${durationMin} min`);
  console.log(
    `Time range:     ${formatTime(first.ts)} → ${formatTime(last.ts)}`,
  );
  console.log(`Total events:   ${events.length}`);
  console.log();
  console.log("--- Requests ---");
  console.log(`Started:        ${starts.length}`);
  console.log(`Completed:      ${completions.length}`);
  console.log(`Errored:        ${errors.length}`);
  console.log(`Summarizations: ${summarizations}`);
  console.log();
  console.log("--- Tokens ---");
  console.log(`Input:          ${totalInput.toLocaleString()}`);
  console.log(`Output:         ${totalOutput.toLocaleString()}`);
  console.log(`Cached:         ${totalCached.toLocaleString()}`);
  console.log();
  console.log("--- Activity ---");
  console.log(`Tree changes:   ${treeChanges.length}`);
  console.log(`Index entries:  ${indices.length}`);
  console.log();
  console.log(
    "Hint: query-events tree                 # Reconstructed agent tree",
  );
  console.log(
    "Hint: query-events conversations        # List all conversations",
  );
}

function cmdRequest(events: EventBase[], chatId: string, json: boolean): void {
  // Match by full chatId or suffix
  const matching = events.filter(
    (e) => e.chatId === chatId || e.chatId?.endsWith(chatId),
  );

  if (matching.length === 0) {
    // Also check causedByChatId
    const caused = events.filter(
      (e) =>
        e.causedByChatId === chatId ||
        (e.causedByChatId && e.causedByChatId.endsWith(chatId)),
    );
    if (caused.length > 0) {
      console.log(
        `No events with chatId matching "${chatId}", but found ${caused.length} events caused by it:\n`,
      );
      printEvents(caused, json);
      return;
    }
    console.log(`No events found for chatId "${chatId}".`);
    return;
  }

  console.log(`--- ${matching.length} events for chatId *${chatId} ---\n`);
  printEvents(matching, json);
}

function cmdTrace(events: EventBase[], chatId: string, json: boolean): void {
  // Find the originating request
  const origin = events.filter(
    (e) =>
      (e.chatId === chatId || e.chatId?.endsWith(chatId)) &&
      e.kind === "agent.started",
  );

  // Find all effects (events caused by this chatId)
  const effects = events.filter(
    (e) =>
      e.causedByChatId === chatId ||
      (e.causedByChatId && e.causedByChatId.endsWith(chatId)),
  );

  // Find the completion/error
  const completion = events.filter(
    (e) =>
      (e.chatId === chatId || e.chatId?.endsWith(chatId)) &&
      (e.kind === "agent.completed" || e.kind === "agent.errored"),
  );

  // Find request.index
  const index = events.filter(
    (e) =>
      (e.chatId === chatId || e.chatId?.endsWith(chatId)) &&
      e.kind === "request.index",
  );

  const all = [...origin, ...index, ...effects, ...completion];
  // Deduplicate by eventId and sort by ts
  const seen = new Set<string>();
  const unique = all.filter((e) => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    return true;
  });
  unique.sort((a, b) => a.ts.localeCompare(b.ts));

  if (unique.length === 0) {
    console.log(`No causality chain found for chatId "${chatId}".`);
    return;
  }

  console.log(`--- Causality trace for *${chatId} ---\n`);

  if (json) {
    printEvents(unique, true);
    return;
  }

  // Print with causality annotations
  for (const e of unique) {
    const prefix =
      e.kind === "agent.started"
        ? "→ CAUSE  "
        : e.causedByChatId
          ? "← EFFECT "
          : "  ···    ";
    console.log(`${prefix}${formatEvent(e)}`);
  }
}

function cmdErrors(events: EventBase[], json: boolean): void {
  const errors = events.filter(
    (e) =>
      e.kind === "agent.errored" ||
      (e.kind === "request.index" && (e as any).entry?.status === "error"),
  );

  if (errors.length === 0) {
    console.log("No errors found. 🎉");
    return;
  }

  console.log(`--- ${errors.length} error events ---\n`);
  printEvents(errors, json);
}

function cmdConversations(events: EventBase[]): void {
  const convMap = new Map<
    string,
    { requests: number; errors: number; firstSeen: string; lastSeen: string }
  >();

  for (const e of events) {
    const id = e.conversationId;
    if (!id || id === "unknown") continue;

    let entry = convMap.get(id);
    if (!entry) {
      entry = { requests: 0, errors: 0, firstSeen: e.ts, lastSeen: e.ts };
      convMap.set(id, entry);
    }
    entry.lastSeen = e.ts;

    if (e.kind === "agent.started") entry.requests++;
    if (e.kind === "agent.errored") entry.errors++;
  }

  if (convMap.size === 0) {
    console.log("No conversations found.");
    return;
  }

  console.log(`--- ${convMap.size} conversations ---\n`);
  console.log(
    "CONVERSATION".padEnd(40) +
      "REQUESTS".padEnd(10) +
      "ERRORS".padEnd(8) +
      "FIRST SEEN".padEnd(16) +
      "LAST SEEN",
  );
  console.log("-".repeat(90));

  for (const [id, data] of convMap) {
    const display = id.length > 36 ? id.slice(0, 36) + "…" : id;
    const errStr = data.errors > 0 ? `${data.errors} ⚠️` : "0";
    console.log(
      `${display.padEnd(40)}${String(data.requests).padEnd(10)}${errStr.padEnd(8)}${formatTime(data.firstSeen).padEnd(16)}${formatTime(data.lastSeen)}`,
    );
  }

  console.log();
  console.log(
    "Hint: query-events conversation <id>    # Full history for a conversation",
  );
  console.log(
    "Hint: query-events tree                 # Reconstructed agent tree",
  );
}

function cmdTree(
  events: EventBase[],
  atEventId?: string,
  json?: boolean,
): void {
  const conversations = reconstructTree(events, atEventId);

  if (conversations.length === 0) {
    console.log("No conversations found.");
    return;
  }

  if (json) {
    console.log(JSON.stringify(conversations, null, 2));
    return;
  }

  const heading = atEventId
    ? `=== Agent Tree (at ${atEventId}) ===`
    : "=== Agent Tree (current) ===";
  console.log(`${heading}\n`);

  for (const conv of conversations) {
    const title = conv.title ? conv.title : "(untitled)";
    const status = statusIndicator(conv.status);
    const input = formatTokenValue(conv.tokens?.input);
    const maxInput = formatTokenValue(conv.tokens?.maxInput);
    const percent = formatPercentage(conv.tokens?.input, conv.tokens?.maxInput);
    const forkInfo = conv.forkedFrom
      ? ` (forked from ${conv.forkedFrom.conversationId} at #${conv.forkedFrom.atSequence})`
      : "";
    console.log(
      `${status} ${conv.modelId ?? "(model)"} — ${title}    ${input}/${maxInput} · ${percent}${forkInfo}`,
    );

    const activityLog = conv.activityLog ?? [];
    const subagents = conv.subagents ?? [];
    const totalItems = activityLog.length + subagents.length;
    let emitted = 0;

    for (let i = 0; i < activityLog.length; i++) {
      const entry = activityLog[i];
      const isLast = emitted === totalItems - 1;
      printTreeLine("  ", isLast, formatActivityEntry(entry));
      emitted++;
    }

    for (let i = 0; i < subagents.length; i++) {
      const isLast = emitted === totalItems - 1;
      printSubagent(subagents[i], "  ", isLast);
      emitted++;
    }

    console.log();
  }

  const hintId = conversations[0]?.id;
  if (hintId) {
    console.log(
      `Hint: query-events conversation ${hintId}    # Full history for a conversation`,
    );
  }
  console.log(
    "Hint: query-events request <chatId>     # Details of a specific request",
  );
}

function cmdConversation(
  events: EventBase[],
  conversationId: string,
  json?: boolean,
): void {
  const conversations = reconstructTree(events);
  const conversation = conversations.find((conv) =>
    matchById(conv?.id, conversationId),
  );

  if (!conversation) {
    console.log(`No conversation found for id "${conversationId}".`);
    return;
  }

  if (json) {
    console.log(JSON.stringify(conversation, null, 2));
    return;
  }

  const title = conversation.title ? conversation.title : "(untitled)";
  const input = formatTokenValue(conversation.tokens?.input);
  const maxInput = formatTokenValue(conversation.tokens?.maxInput);
  const percent = formatPercentage(
    conversation.tokens?.input,
    conversation.tokens?.maxInput,
  );

  console.log(`=== Conversation: ${title} ===`);
  console.log(`ID:     ${conversation.id}`);
  console.log(`Model:  ${conversation.modelId ?? "(model)"}`);
  console.log(`Status: ${conversation.status ?? "?"}`);
  console.log(`Tokens: ${input} / ${maxInput} (${percent})`);
  console.log(`Turns:  ${conversation.turnCount ?? 0}`);

  if (conversation.forkedFrom) {
    console.log(
      `Forked from: ${conversation.forkedFrom.conversationId} at sequence #${conversation.forkedFrom.atSequence}`,
    );
  }

  console.log("\n--- Activity Log ---\n");

  const activityLog = conversation.activityLog ?? [];
  for (const entry of activityLog) {
    if (entry.type === "user-message") {
      const preview = entry.preview ? `"${entry.preview}"` : "(user message)";
      const seq = entry.sequenceNumber ?? "?";
      const tokens = formatTokenDelta(entry.tokenContribution);
      const tokenPart = tokens ? `  ${tokens}` : "";
      console.log(`  #${seq}  ${preview}${tokenPart}`);
      continue;
    }

    if (entry.type === "ai-response") {
      const label = entry.characterization ?? "(AI response)";
      const seq = entry.sequenceNumber ?? "?";
      const tokens = formatTokenDelta(entry.tokenContribution);
      const tools = entry.toolsUsed?.length ? entry.toolsUsed.join(", ") : "";
      const toolPart = tools ? `  (${tools})` : "";
      const streaming = entry.state === "streaming" ? "  (streaming...)" : "";
      const tokenPart = tokens ? `  ${tokens}` : "";
      console.log(`  #${seq}  ${label}${tokenPart}${toolPart}${streaming}`);
      continue;
    }

    if (entry.type === "compaction") {
      const turn = entry.turnNumber ?? "?";
      console.log(
        `  #${turn}  [compaction: freed ${entry.freedTokens ?? 0} tokens]`,
      );
      continue;
    }

    if (entry.type === "error") {
      const turn = entry.turnNumber ?? "?";
      console.log(`  #${turn}  ⚠ ${entry.message ?? "(error)"}`);
    }
  }

  console.log("\n--- Subagents ---\n");

  const subagents = conversation.subagents ?? [];
  if (subagents.length === 0) {
    console.log("  (none)");
  } else {
    const printSubagentLine = (subagent: any, depth: number): void => {
      const indent = "  ".repeat(depth + 1);
      const inputTokens = formatTokenValue(subagent.tokens?.input);
      const outputTokens = formatTokenValue(subagent.tokens?.output);
      console.log(
        `${indent}${subagent.id ?? "(subagent)"}  ${subagent.name ?? ""}  ${subagent.status ?? "?"}  ${inputTokens}/${outputTokens}`,
      );
      const children = subagent.children ?? [];
      for (const child of children) {
        printSubagentLine(child, depth + 1);
      }
    };

    for (const subagent of subagents) {
      printSubagentLine(subagent, 0);
    }
  }

  console.log(
    "\nHint: query-events request <chatId>     # Details of a specific request",
  );
  console.log("Hint: query-events tree                 # Full agent tree");
}

// ─────────────────────────────────────────────────────────────────────────────
// Perception Command
// ─────────────────────────────────────────────────────────────────────────────

import {
  aiResponseDescriptionParts,
  aiResponseLabel,
  buildTree,
  type TreeNode,
  type TreeChild,
  type TreeResult,
} from "@vercel/conversation";

/**
 * Build a chatId-to-sequence mapping from request.index events.
 * Each request.index has a unique chatId and a messageCount.
 * messageCount / 2 ≈ turn number, and we correlate by timestamp proximity.
 */
function buildChatIdMap(
  events: EventBase[],
  conversationId: string,
): Map<number, string> {
  // Map: sequence number → per-request chatId
  const seqToChatId = new Map<number, string>();

  // Get request.index events for this conversation, sorted by timestamp
  const indices = events.filter(
    (e) => e.kind === "request.index" && e.conversationId === conversationId,
  );

  // Get user-message-added tree.change events for this conversation
  const userMsgEvents = events.filter(
    (e) =>
      e.kind === "tree.change" &&
      e.conversationId === conversationId &&
      (e as any).op?.type === "user-message-added",
  );

  // Strategy: correlate by timestamp proximity.
  // For each request.index, find the closest user-message-added event.
  for (const idx of indices) {
    const idxTime = new Date(idx.ts).getTime();
    const chatId = idx.chatId;

    let bestSeq: number | null = null;
    let bestDist = Infinity;

    for (const um of userMsgEvents) {
      const umTime = new Date(um.ts).getTime();
      const dist = Math.abs(idxTime - umTime);
      const seq = (um as any).op?.entry?.sequenceNumber;
      if (seq !== undefined && dist < bestDist) {
        bestDist = dist;
        bestSeq = seq;
      }
    }

    if (bestSeq !== null && bestDist < 30000) {
      // Only correlate if within 30 seconds
      seqToChatId.set(bestSeq, chatId);
    }
  }

  return seqToChatId;
}

function shortChatId(chatId: string): string {
  if (!chatId || chatId === "unknown") return "unknown";
  return chatId.slice(-12);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function fmtTokensCli(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

/**
 * Render a single tree node line for the perception view.
 * Mirrors the labels from tree-items.ts in the extension.
 */
function renderNodeLine(
  node: TreeNode,
  chatIdMap: Map<number, string>,
  indent: string,
  prefix: string,
  childIndent: string,
): string[] {
  const lines: string[] = [];

  switch (node.kind) {
    case "user-message": {
      const preview = node.entry.preview?.trim();
      const label = preview
        ? `"${truncate(preview, 60)}"`
        : `Message #${node.entry.sequenceNumber}`;
      const seq = node.entry.sequenceNumber;
      const chatId = chatIdMap.get(seq);
      const chatPart = chatId ? `  chat=${shortChatId(chatId)}` : "";
      const errorMarker = node.hasError ? "  ⚠ error" : "";
      lines.push(
        `${indent}${prefix}👤 ${label}  #${seq}${chatPart}${errorMarker}`,
      );

      for (let j = 0; j < node.children.length; j++) {
        const child = node.children[j]!;
        const childIsLast = j === node.children.length - 1;
        const cp = childIsLast ? "└─ " : "├─ ";

        lines.push(`${indent}${childIndent}${cp}${renderChildLine(child)}`);
      }
      break;
    }
    case "compaction": {
      const freed = fmtTokensCli(node.entry.freedTokens);
      const turn = node.entry.turnNumber;
      const kind =
        node.entry.compactionType === "summarization"
          ? "Compacted"
          : "Context managed";
      lines.push(`${indent}${prefix}↓ ${kind} ${freed} (turn ${turn})`);
      break;
    }
    case "error":
      lines.push(`${indent}${prefix}✗ ${truncate(node.entry.message, 60)}`);
      break;
    case "history":
      lines.push(
        `${indent}${prefix}▸ History (${node.count} earlier ${node.count === 1 ? "entry" : "entries"})`,
      );
      break;
  }

  return lines;
}

function renderChildLine(child: TreeChild): string {
  switch (child.kind) {
    case "ai-response": {
      const label = aiResponseLabel(child.entry);
      const descParts = aiResponseDescriptionParts(child.entry, child.tools);
      const streaming =
        child.entry.state === "streaming" ? " (streaming...)" : "";
      const descStr = descParts.length > 0 ? `  ${descParts.join(" · ")}` : "";
      return `${label}${descStr}${streaming}`;
    }
    case "error":
      return `✗ ${truncate(child.entry.message, 60)}`;
  }
}

function cmdPerception(events: EventBase[], json?: boolean): void {
  const conversations = reconstructTree(events);

  if (conversations.length === 0) {
    console.log("No conversations found.");
    console.log(
      "\nHint: query-events session               # Check if events exist",
    );
    return;
  }

  if (json) {
    console.log(JSON.stringify(conversations, null, 2));
    return;
  }

  const active = conversations.filter((c: any) => c.status === "active");
  const archived = conversations.filter((c: any) => c.status !== "active");

  console.log("=== Agent Tree ===\n");

  for (const conv of active) {
    const title = conv.title ? conv.title : "(untitled)";
    const input = formatTokenValue(conv.tokens?.input);
    const maxInput = formatTokenValue(conv.tokens?.maxInput);
    const percent = formatPercentage(conv.tokens?.input, conv.tokens?.maxInput);
    const model = conv.modelId ?? "(model)";
    const forkInfo = conv.forkedFrom
      ? `  (forked from ${conv.forkedFrom.conversationId} at #${conv.forkedFrom.atSequence})`
      : "";

    console.log(`● ${title}`);
    console.log(
      `  Model: ${model}  Tokens: ${input}/${maxInput} (${percent})${forkInfo}`,
    );

    const chatIdMap = buildChatIdMap(events, conv.id);
    const activityLog = conv.activityLog ?? [];
    const tree: TreeResult = buildTree(activityLog);

    if (tree.topLevel.length === 0) {
      console.log("  (no activity yet)\n");
      console.log(
        `  → query-events conversation ${conv.id}  # Full conversation details`,
      );
      console.log();
      continue;
    }

    console.log();

    // Render all top-level nodes (already in reverse chronological order)
    for (let i = 0; i < tree.topLevel.length; i++) {
      const node = tree.topLevel[i]!;
      const isLast = i === tree.topLevel.length - 1;
      const prefix = isLast ? "└─ " : "├─ ";
      const childIndent = isLast ? "    " : "│   ";

      const nodeLines = renderNodeLine(
        node,
        chatIdMap,
        "  ",
        prefix,
        childIndent,
      );
      for (const line of nodeLines) {
        console.log(line);
      }
    }

    console.log();
    console.log(
      `  → query-events conversation ${conv.id.slice(0, 8)}    # Full history`,
    );
    console.log(
      `  → query-events entry ${conv.id.slice(0, 8)} <seq>     # Details of entry #<seq>`,
    );

    // Show drill-down hint for the most recent turn's chatId
    const firstNode = tree.topLevel[0];
    if (firstNode?.kind === "user-message") {
      const chatId = chatIdMap.get(firstNode.entry.sequenceNumber);
      if (chatId) {
        console.log(
          `  → query-events request ${shortChatId(chatId)}    # Events for latest turn`,
        );
      }
    }

    console.log();
  }

  // Show archived conversations as a summary
  if (archived.length > 0) {
    console.log(
      `📁 History: ${archived.length} archived conversation${archived.length === 1 ? "" : "s"}`,
    );
    for (const conv of archived) {
      const title = conv.title ? truncate(conv.title, 50) : "(untitled)";
      const input = formatTokenValue(conv.tokens?.input);
      const maxInput = formatTokenValue(conv.tokens?.maxInput);
      const percent = formatPercentage(
        conv.tokens?.input,
        conv.tokens?.maxInput,
      );
      const logCount = (conv.activityLog ?? []).length;
      const subCount = (conv.subagents ?? []).length;
      const subPart =
        subCount > 0
          ? `  ${subCount} subagent${subCount === 1 ? "" : "s"}`
          : "";
      console.log(
        `  △ ${title}  ${input}/${maxInput} (${percent})  ${logCount} entries${subPart}`,
      );
    }
    console.log();
    console.log(
      "  → query-events conversations              # List all with request counts",
    );
    console.log(
      "  → query-events tree                       # Full tree (all conversations)",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry Command
// ─────────────────────────────────────────────────────────────────────────────

function cmdEntry(
  events: EventBase[],
  conversationId: string,
  sequenceNumber: number,
  json?: boolean,
): void {
  const conversations = reconstructTree(events);
  const conversation = conversations.find((conv: any) =>
    matchById(conv?.id, conversationId),
  );

  if (!conversation) {
    console.log(`No conversation found for id "${conversationId}".`);
    return;
  }

  const activityLog = conversation.activityLog ?? [];
  const entry = activityLog.find(
    (e: any) =>
      e.sequenceNumber === sequenceNumber || e.turnNumber === sequenceNumber,
  );

  if (!entry) {
    console.log(
      `No entry found at sequence #${sequenceNumber} in conversation ${conversationId}.`,
    );
    console.log(
      `\nAvailable sequences: ${activityLog
        .map((e: any) => `#${e.sequenceNumber ?? e.turnNumber ?? "?"}`)
        .join(", ")}`,
    );
    return;
  }

  if (json) {
    console.log(JSON.stringify(entry, null, 2));
    return;
  }

  const convTitle = conversation.title
    ? truncate(conversation.title, 40)
    : "(untitled)";
  console.log(`=== Entry #${sequenceNumber} in "${convTitle}" ===\n`);

  // Find the request.index event that corresponds to this entry
  const chatIdMap = buildChatIdMap(events, conversation.id);
  // For AI responses, look up the preceding user message's chatId
  let relevantChatId: string | undefined;
  if (entry.type === "user-message") {
    relevantChatId = chatIdMap.get(entry.sequenceNumber);
  } else if (entry.type === "ai-response") {
    // AI response shares sequence number with its user message
    relevantChatId = chatIdMap.get(entry.sequenceNumber);
  }

  console.log(`Type:           ${entry.type}`);

  if (entry.type === "user-message") {
    console.log(`Sequence:       #${entry.sequenceNumber ?? "?"}`);
    console.log(
      `Preview:        ${entry.preview ? `"${entry.preview}"` : "(none)"}`,
    );
    console.log(
      `Tokens:         ${entry.tokenContribution !== undefined ? `+${entry.tokenContribution}` : "?"}`,
    );
    if (entry.isToolContinuation) {
      console.log(`Tool continue:  yes`);
    }
    console.log(
      `Timestamp:      ${entry.timestamp ? new Date(entry.timestamp).toISOString() : "?"}`,
    );
  }

  if (entry.type === "ai-response") {
    console.log(`Sequence:       #${entry.sequenceNumber ?? "?"}`);
    console.log(`State:          ${entry.state ?? "?"}`);
    console.log(`Characterization: ${entry.characterization ?? "(none)"}`);
    console.log(
      `Tokens:         ${entry.tokenContribution !== undefined ? `+${entry.tokenContribution}` : "?"}`,
    );
    if (entry.toolCalls?.length) {
      console.log(`Tool calls:     ${entry.toolCalls.length} call(s)`);
      for (const tc of entry.toolCalls) {
        const argSummary = Object.keys(tc.args).join(", ");
        console.log(`  → ${tc.name}(${argSummary}) [${tc.callId}]`);
      }
    } else if (entry.toolsUsed?.length) {
      console.log(`Tools used:     ${entry.toolsUsed.join(", ")}`);
    }
    if (entry.subagentIds?.length) {
      console.log(`Subagent IDs:   ${entry.subagentIds.join(", ")}`);
    }
    console.log(
      `Timestamp:      ${entry.timestamp ? new Date(entry.timestamp).toISOString() : "?"}`,
    );
  }

  if (entry.type === "compaction") {
    console.log(`Turn:           #${entry.turnNumber ?? "?"}`);
    console.log(`Freed tokens:   ${entry.freedTokens ?? 0}`);
    console.log(`Type:           ${entry.compactionType ?? "?"}`);
    if (entry.details) {
      console.log(`Details:        ${entry.details}`);
    }
    console.log(
      `Timestamp:      ${entry.timestamp ? new Date(entry.timestamp).toISOString() : "?"}`,
    );
  }

  if (entry.type === "error") {
    console.log(`Turn:           #${entry.turnNumber ?? "?"}`);
    console.log(`Message:        ${entry.message ?? "(none)"}`);
    console.log(
      `Timestamp:      ${entry.timestamp ? new Date(entry.timestamp).toISOString() : "?"}`,
    );
  }

  // Hints
  console.log();
  if (relevantChatId && relevantChatId !== "unknown") {
    console.log(
      `→ query-events request ${shortChatId(relevantChatId)}    # All events for this request`,
    );
  }
  console.log(
    `→ query-events conversation ${conversationId.slice(0, 8)}    # Full conversation`,
  );
  console.log(
    `→ query-events perception                   # Back to tree overview`,
  );
}

function cmdSearch(events: EventBase[], query: string, json: boolean): void {
  const lower = query.toLowerCase();
  const matching = events.filter((e) =>
    JSON.stringify(e).toLowerCase().includes(lower),
  );

  if (matching.length === 0) {
    console.log(`No events matching "${query}".`);
    return;
  }

  console.log(`--- ${matching.length} events matching "${query}" ---\n`);
  printEvents(matching, json);
}

function cmdKinds(events: EventBase[]): void {
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  }

  if (counts.size === 0) {
    console.log("No events found.");
    return;
  }

  console.log(`--- Event kinds (${events.length} total) ---\n`);

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of sorted) {
    const bar = "█".repeat(
      Math.min(50, Math.round((count / events.length) * 50)),
    );
    console.log(`${kind.padEnd(24)} ${String(count).padStart(6)}  ${bar}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string>;
} {
  const args = argv.slice(2);
  const command = args[0] ?? "tail";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  let i = 1;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1] ?? "true";
      flags[key] = value;
      i += 2;
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { command, positional, flags };
}

function autoDetectInvestigation(logDir: string): string | null {
  const resolved = path.resolve(logDir);
  if (!fs.existsSync(resolved)) return null;
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        fs.existsSync(path.join(resolved, entry.name, "events.jsonl"))
      ) {
        return entry.name;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveEventsFile(flags: Record<string, string>): string {
  const logDir = flags["log-dir"] ?? ".logs";
  let investigation = flags["investigation"];

  // Auto-detect investigation if not specified
  if (!investigation) {
    investigation = autoDetectInvestigation(logDir) ?? "default";
  }

  // Try workspace-relative first, then absolute
  const candidates = [
    path.resolve(logDir, investigation, "events.jsonl"),
    path.resolve(process.cwd(), logDir, investigation, "events.jsonl"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Return the first candidate path even if it doesn't exist
  return candidates[0]!;
}

/** Default tail size: 50MB covers ~50k events, enough for any single session. */
const DEFAULT_TAIL_BYTES = 50 * 1024 * 1024;

/** Commands that can work with just the tail of the file. */
const TAIL_SAFE_COMMANDS = new Set([
  "perception",
  "tail",
  "conversation",
  "entry",
  "request",
  "trace",
  "errors",
  "conversations",
  "tree",
]);

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);
  const eventsFile = resolveEventsFile(flags);
  const json = "json" in flags;

  // Use tail-read for commands that only need recent data, full stream otherwise.
  // --full flag forces full file read.
  const forceFull = "full" in flags;
  const tailBytes = flags["tail-bytes"]
    ? parseInt(flags["tail-bytes"], 10)
    : DEFAULT_TAIL_BYTES;

  let events: EventBase[];
  if (!forceFull && TAIL_SAFE_COMMANDS.has(command)) {
    events = await loadRecentEvents(eventsFile, tailBytes);
  } else {
    events = await loadEvents(eventsFile);
  }

  if (events.length === 0 && command !== "tail") {
    console.log(`No events found at: ${eventsFile}`);
    console.log(
      "Make sure the extension is running with investigation logging enabled.",
    );
    return;
  }

  // Apply global filters
  events = applyFilters(events, {
    since: flags["since"],
    until: flags["until"],
    kind: flags["kind"],
    conversation: flags["conversation"],
  });

  switch (command) {
    case "perception":
      cmdPerception(events, json);
      break;

    case "tail":
      cmdTail(events, parseInt(flags["count"] ?? "20", 10), json);
      break;

    case "session":
      cmdSession(events);
      break;

    case "request": {
      const chatId = positional[0];
      if (!chatId) {
        console.error("Usage: query-events request <chatId>");
        process.exit(1);
      }
      cmdRequest(events, chatId, json);
      break;
    }

    case "trace": {
      const chatId = positional[0];
      if (!chatId) {
        console.error("Usage: query-events trace <chatId>");
        process.exit(1);
      }
      cmdTrace(events, chatId, json);
      break;
    }

    case "errors":
      cmdErrors(events, json);
      break;

    case "conversations":
      cmdConversations(events);
      break;

    case "tree": {
      const atEventId = flags["at"];
      cmdTree(events, atEventId, json);
      break;
    }

    case "conversation": {
      const convId = positional[0];
      if (!convId) {
        console.error("Usage: query-events conversation <id>");
        process.exit(1);
      }
      cmdConversation(events, convId, json);
      break;
    }

    case "search": {
      const query = positional[0];
      if (!query) {
        console.error("Usage: query-events search <text>");
        process.exit(1);
      }
      cmdSearch(events, query, json);
      break;
    }

    case "entry": {
      const entryConvId = positional[0];
      const entrySeq = positional[1];
      if (!entryConvId || !entrySeq) {
        console.error("Usage: query-events entry <conversationId> <sequence>");
        process.exit(1);
      }
      // Strip leading # from sequence number if present
      const seqNum = parseInt(entrySeq.replace(/^#/, ""), 10);
      if (Number.isNaN(seqNum)) {
        console.error(`Invalid sequence number: ${entrySeq}`);
        process.exit(1);
      }
      cmdEntry(events, entryConvId, seqNum, json);
      break;
    }

    case "kinds":
      cmdKinds(events);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "Commands: perception, tail, session, request, trace, errors, conversations, conversation, tree, entry, search, kinds",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
