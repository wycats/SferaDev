#!/usr/bin/env node
/**
 * Event Stream Query Tool
 *
 * Structured query interface for the unified events.jsonl log.
 * Designed for agent use: answers questions about what happened,
 * traces causality chains, and summarizes sessions.
 *
 * Usage:
 *   node scripts/query-events.ts <command> [options]
 *
 * Commands:
 *   tail [--count N]                    Last N events (default 20)
 *   session                             Session overview (requests, tokens, errors)
 *   request <chatId>                    All events for a specific request
 *   trace <chatId>                      Causality chain: what did this request cause?
 *   errors                              All error events and agent.errored
 *   conversations                       List conversations with request counts
 *   search <text>                       Full-text search across event JSON
 *   kinds                               Count events by kind
 *
 * Options:
 *   --log-dir <path>                    Log directory (default: .logs)
 *   --investigation <name>              Investigation name (default: default)
 *   --since <ISO|relative>              Filter events after this time
 *   --until <ISO|relative>              Filter events before this time
 *   --kind <kind>                       Filter by event kind
 *   --conversation <id>                 Filter by conversationId
 *   --json                              Output raw JSON instead of formatted text
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

function loadEvents(filePath: string): EventBase[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  const events: EventBase[] = [];
  for (const line of content.split("\n")) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

interface FilterOptions {
  since?: string;
  until?: string;
  kind?: string;
  conversation?: string;
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
      unit === "s" ? amount * 1000 : unit === "m" ? amount * 60000 : amount * 3600000;
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
      const inp = entry?.actualInputTokens ?? entry?.estimatedInputTokens ?? "?";
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
      const caused = tc.causedByChatId ? `  caused-by=${tc.causedByChatId.slice(-12)}` : "";
      return `${time} [${id}] TREE CHANGE    ${tc.event}${caused}`;
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
  console.log(`Time range:     ${formatTime(first.ts)} → ${formatTime(last.ts)}`);
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
    const bar = "█".repeat(Math.min(50, Math.round((count / events.length) * 50)));
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

function resolveEventsFile(flags: Record<string, string>): string {
  const logDir = flags["log-dir"] ?? ".logs";
  const investigation = flags["investigation"] ?? "default";

  // Try workspace-relative first, then absolute
  const candidates = [
    path.resolve(logDir, investigation, "events.jsonl"),
    path.resolve(
      process.cwd(),
      logDir,
      investigation,
      "events.jsonl",
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Return the first candidate path even if it doesn't exist
  return candidates[0]!;
}

function main(): void {
  const { command, positional, flags } = parseArgs(process.argv);
  const eventsFile = resolveEventsFile(flags);
  const json = "json" in flags;

  let events = loadEvents(eventsFile);

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

    case "search": {
      const query = positional[0];
      if (!query) {
        console.error("Usage: query-events search <text>");
        process.exit(1);
      }
      cmdSearch(events, query, json);
      break;
    }

    case "kinds":
      cmdKinds(events);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "Commands: tail, session, request, trace, errors, conversations, search, kinds",
      );
      process.exit(1);
  }
}

main();
