/**
 * Property-based tests for the activity log tree.
 *
 * SUT: buildTree() from build-tree.ts
 * Strategy: docs/rfcs/stage-1/00073-conversation-centric-agent-tree.property-strategy.md
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import type {
  ActivityLogEntry,
  AIResponseEntry,
  CompactionEntry,
  ErrorEntry,
  UserMessageEntry,
} from "./types.js";
import {
  buildTree,
  isActualUserMessage,
  renderTree,
  windowActivityLog,
  WINDOW_SIZE,
  type TreeChild,
  type TreeNode,
  type TreeResult,
} from "./build-tree.js";

// =====================================================================
// Generator: Grammar-Based ActivityLogEntry[] Arbitrary
// =====================================================================

const TOOL_NAMES = [
  "read_file",
  "grep_search",
  "list_dir",
  "run_in_terminal",
  "create_file",
  "semantic_search",
  "file_search",
  "get_errors",
];

const MAX_ENTRIES = 600;

const arbPreview = fc.oneof(
  {
    weight: 7,
    arbitrary: fc.lorem({ maxCount: 8 }).map((s) => s.slice(0, 80)),
  },
  { weight: 3, arbitrary: fc.constant(undefined) },
);

const arbCharacterization = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.lorem({ maxCount: 6 }).map((s) => s.slice(0, 60)),
  },
  { weight: 2, arbitrary: fc.constant(undefined) },
);

const arbTokens = fc.integer({ min: 50, max: 5000 });

const arbSeqGap = fc.oneof(
  { weight: 95, arbitrary: fc.constant(1) },
  { weight: 3, arbitrary: fc.constant(2) },
  { weight: 2, arbitrary: fc.constant(3) },
);

const arbTimeDelta = fc.integer({ min: 900, max: 1100 });

function arbGeometricInt(
  min: number,
  max: number,
  p: number,
): fc.Arbitrary<number> {
  const weights: { weight: number; arbitrary: fc.Arbitrary<number> }[] = [];
  for (let k = min; k < max; k++) {
    const weight = Math.max(1, Math.round(Math.pow(1 - p, k - min) * p * 1000));
    weights.push({ weight, arbitrary: fc.constant(k) });
  }
  const tailWeight = Math.max(1, Math.round(Math.pow(1 - p, max - min) * 1000));
  weights.push({ weight: tailWeight, arbitrary: fc.constant(max) });
  return fc.oneof(...weights);
}

const arbToolLoopDepth = arbGeometricInt(0, 4, 0.4);
const arbToolCount = arbGeometricInt(0, 6, 0.5);
const emptyToolList: string[] = [];
const arbToolList = arbToolCount.chain((count) =>
  count === 0
    ? fc.constant(emptyToolList)
    : fc.subarray(TOOL_NAMES, { minLength: count, maxLength: count }),
);

const arbActivityLog: fc.Arbitrary<ActivityLogEntry[]> = fc
  .record({
    numUserMessages: fc.oneof(
      { weight: 2, arbitrary: fc.integer({ min: 1, max: 5 }) },
      { weight: 5, arbitrary: fc.integer({ min: 15, max: 25 }) },
      { weight: 2, arbitrary: fc.integer({ min: 30, max: 40 }) },
      { weight: 1, arbitrary: fc.integer({ min: 6, max: 14 }) },
    ),
    toolLoopDepths: fc.array(arbToolLoopDepth, {
      minLength: 40,
      maxLength: 40,
    }),
    toolLists: fc.array(arbToolList, {
      minLength: MAX_ENTRIES,
      maxLength: MAX_ENTRIES,
    }),
    previews: fc.array(arbPreview, { minLength: 40, maxLength: 40 }),
    characterizations: fc.array(arbCharacterization, {
      minLength: MAX_ENTRIES,
      maxLength: MAX_ENTRIES,
    }),
    tokens: fc.array(arbTokens, {
      minLength: MAX_ENTRIES,
      maxLength: MAX_ENTRIES,
    }),
    gaps: fc.array(arbSeqGap, {
      minLength: MAX_ENTRIES,
      maxLength: MAX_ENTRIES,
    }),
    timeDeltas: fc.array(arbTimeDelta, {
      minLength: MAX_ENTRIES,
      maxLength: MAX_ENTRIES,
    }),
    baseTimestamp: fc.integer({
      min: 1_600_000_000_000,
      max: 1_800_000_000_000,
    }),
    compactionCount: fc.integer({ min: 0, max: 3 }),
    errorCount: fc.integer({ min: 0, max: 4 }),
    compactionPositions: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
      minLength: 3,
      maxLength: 3,
    }),
    errorPositions: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
      minLength: 4,
      maxLength: 4,
    }),
  })
  .map((params) => {
    let seq = 0;
    let time = params.baseTimestamp;
    let toolListIdx = 0;
    let charIdx = 0;
    let tokenIdx = 0;
    let gapIdx = 0;
    let timeIdx = 0;

    const entries: ActivityLogEntry[] = [];

    const nextSeq = (): number => {
      seq += cycle(params.gaps, gapIdx++);
      return seq;
    };

    const nextTokens = (): number => cycle(params.tokens, tokenIdx++);

    const nextTools = (): string[] => cycle(params.toolLists, toolListIdx++);

    const nextChar = (): string | undefined =>
      params.characterizations[charIdx++ % MAX_ENTRIES];

    function makeUserMessage(
      sequenceNumber: number,
      preview: string | undefined,
      tokens: number,
      isToolContinuation: boolean,
    ): UserMessageEntry {
      const entry: UserMessageEntry = {
        type: "user-message",
        sequenceNumber,
        timestamp: 0,
        tokenContribution: tokens,
      };
      if (!isToolContinuation && preview !== undefined) {
        entry.preview = preview;
      }
      if (isToolContinuation) {
        entry.isToolContinuation = true;
      }
      return entry;
    }

    function makeAIResponse(
      sequenceNumber: number,
      characterization: string | undefined,
      tokens: number,
      tools: string[],
    ): AIResponseEntry {
      const entry: AIResponseEntry = {
        type: "ai-response",
        sequenceNumber,
        timestamp: 0,
        state: "characterized",
        tokenContribution: tokens,
        subagentIds: [],
        toolsUsed: tools,
      };
      if (characterization !== undefined) {
        entry.characterization = characterization;
      }
      return entry;
    }

    function makeCompaction(turnNumber: number): CompactionEntry {
      return {
        type: "compaction",
        timestamp: 0,
        turnNumber,
        freedTokens: 5000 + (turnNumber % 5000),
        compactionType: "summarization",
      };
    }

    function makeError(turnNumber: number, message: string): ErrorEntry {
      return {
        type: "error",
        timestamp: 0,
        turnNumber,
        message,
      };
    }

    function buildExchange(maxDepth: number): void {
      const aiSeq = nextSeq();
      entries.push(
        makeAIResponse(aiSeq, nextChar(), nextTokens(), nextTools()),
      );

      for (let depth = 0; depth < maxDepth; depth++) {
        const tcSeq = nextSeq();
        entries.push(makeUserMessage(tcSeq, undefined, nextTokens(), true));

        const aiNextSeq = nextSeq();
        entries.push(
          makeAIResponse(aiNextSeq, nextChar(), nextTokens(), nextTools()),
        );
      }
    }

    for (let i = 0; i < params.numUserMessages; i++) {
      const seqNum = nextSeq();
      entries.push(
        makeUserMessage(seqNum, params.previews[i % 40], nextTokens(), false),
      );
      buildExchange(cycle(params.toolLoopDepths, i, 40));
    }

    const noiseEntries: { entry: ActivityLogEntry; insertAt: number }[] = [];
    for (let i = 0; i < params.compactionCount; i++) {
      const position = params.compactionPositions[i];
      if (position === undefined) {
        throw new Error(`Missing compaction position at ${i}`);
      }
      const insertAt = Math.floor(position * (entries.length + 1));
      const turnNumber = Math.max(1, seq);
      noiseEntries.push({ entry: makeCompaction(turnNumber), insertAt });
    }
    for (let i = 0; i < params.errorCount; i++) {
      const position = params.errorPositions[i];
      if (position === undefined) {
        throw new Error(`Missing error position at ${i}`);
      }
      const insertAt = Math.floor(position * (entries.length + 1));
      const turnNumber = Math.max(1, seq);
      noiseEntries.push({
        entry: makeError(turnNumber, `Error ${i + 1}`),
        insertAt,
      });
    }

    noiseEntries.sort((a, b) => b.insertAt - a.insertAt);
    for (const { entry, insertAt } of noiseEntries) {
      entries.splice(insertAt, 0, entry);
    }

    for (const entry of entries) {
      time += cycle(params.timeDeltas, timeIdx++);
      entry.timestamp = time;
    }

    return entries;
  });

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Access a cycling array element. The array is always a fixed length. */
function cycle<T>(arr: T[], index: number, length = MAX_ENTRIES): T {
  const value = arr[index % length];
  if (value === undefined) {
    throw new Error(`cycle: unexpected undefined at index ${index % length}`);
  }
  return value;
}

function windowedAt(windowed: ActivityLogEntry[], i: number): ActivityLogEntry {
  const entry = windowed[i];
  if (!entry) {
    throw new Error(`windowed[${i}] is undefined`);
  }
  return entry;
}

function formatEntryId(entry: ActivityLogEntry): string {
  return "sequenceNumber" in entry ? `#${entry.sequenceNumber}` : entry.type;
}

function getUserMessageNodes(
  result: TreeResult,
): Extract<TreeNode, { kind: "user-message" }>[] {
  return result.topLevel.filter(
    (n): n is Extract<TreeNode, { kind: "user-message" }> =>
      n.kind === "user-message",
  );
}

function counterexample(
  property: string,
  log: ActivityLogEntry[],
  result: TreeResult,
  detail: string,
): string {
  const inputSummary = log
    .map((e) => {
      switch (e.type) {
        case "user-message":
          return e.isToolContinuation
            ? `TC(${e.sequenceNumber})`
            : `U(${e.sequenceNumber})`;
        case "ai-response":
          return `A(${e.sequenceNumber}${
            e.toolsUsed && e.toolsUsed.length > 0
              ? `, tools=[${e.toolsUsed.join(",")}]`
              : ""
          })`;
        case "compaction":
          return "C";
        case "error":
          return "E";
      }
    })
    .join(" -> ");

  return [
    `PROPERTY VIOLATED: ${property}`,
    "",
    `Input sequence (${log.length} entries):`,
    `  ${inputSummary}`,
    "",
    "Tree:",
    renderTree(result),
    "",
    `Detail: ${detail}`,
  ].join("\n");
}

// =====================================================================
// Properties P1-P18
// =====================================================================

const NUM_RUNS = 200;

describe("Activity Tree Properties", () => {
  it("P1: top-level nodes are only user-message, compaction, error, or history", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        for (const node of result.topLevel) {
          expect(
            ["user-message", "compaction", "error", "history"].includes(
              node.kind,
            ),
            counterexample(
              "P1: Top-level node containment",
              log,
              result,
              `Found kind="${node.kind}"`,
            ),
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P2: user-message children are only ai-response, tool-continuation, or error", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        for (const node of getUserMessageNodes(result)) {
          for (const child of node.children) {
            expect(
              ["ai-response", "tool-continuation", "error"].includes(
                child.kind,
              ),
              counterexample(
                "P2: Child node containment",
                log,
                result,
                `Found child kind="${child.kind}"`,
              ),
            ).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P3: errors after a user message belong to that group", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);
        const userNodes = getUserMessageNodes(result);

        for (let i = 0; i < windowed.length; i++) {
          const entry = windowedAt(windowed, i);
          if (entry.type !== "error") continue;

          let prevActualIdx = -1;
          for (let j = i - 1; j >= 0; j--) {
            const candidate = windowedAt(windowed, j);
            if (isActualUserMessage(candidate)) {
              prevActualIdx = j;
              break;
            }
          }

          if (prevActualIdx === -1) continue;

          const parentEntry = windowed[prevActualIdx];
          if (parentEntry?.type !== "user-message") continue;
          const parentNode = userNodes.find((n) => n.entry === parentEntry);

          expect(
            parentNode,
            counterexample(
              "P3: Error nesting",
              log,
              result,
              `No parent group for error at windowed index ${i}`,
            ),
          ).toBeDefined();

          if (!parentNode) continue;
          const isChild = parentNode.children.some(
            (c) => c.kind === "error" && c.entry === entry,
          );

          expect(
            isChild,
            counterexample(
              "P3: Error nesting",
              log,
              result,
              `Error entry not nested under U(${parentEntry.sequenceNumber})`,
            ),
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P4: hasError is true iff any child is an error", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        for (const node of getUserMessageNodes(result)) {
          const hasErrorChild = node.children.some((c) => c.kind === "error");
          expect(
            node.hasError,
            counterexample(
              "P4: Error parent inflection",
              log,
              result,
              `U(${node.entry.sequenceNumber}) hasError=${node.hasError}, childrenError=${hasErrorChild}`,
            ),
          ).toBe(hasErrorChild);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P5: errors before first actual user message are top-level", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);
        const userNodes = getUserMessageNodes(result);

        const firstActualIdx = windowed.findIndex((e) =>
          isActualUserMessage(e),
        );
        if (firstActualIdx === -1) return;

        for (let i = 0; i < firstActualIdx; i++) {
          const entry = windowedAt(windowed, i);
          if (entry.type !== "error") continue;

          const topLevelHasError = result.topLevel.some(
            (n) => n.kind === "error" && n.entry === entry,
          );
          const nestedAsChild = userNodes.some((n) =>
            n.children.some((c) => c.kind === "error" && c.entry === entry),
          );

          expect(
            topLevelHasError,
            counterexample(
              "P5: Orphan error handling",
              log,
              result,
              `Orphan error before first user message not top-level at index ${i}`,
            ),
          ).toBe(true);

          expect(
            nestedAsChild,
            counterexample(
              "P5: Orphan error handling",
              log,
              result,
              `Orphan error incorrectly nested at index ${i}`,
            ),
          ).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P6: tool continuation is never the first child of a group", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        for (const node of getUserMessageNodes(result)) {
          if (node.children.length === 0) continue;
          const firstChild = node.children[0];
          expect(
            firstChild,
            counterexample(
              "P6: Tool continuation placement",
              log,
              result,
              `Missing first child for U(${node.entry.sequenceNumber})`,
            ),
          ).toBeDefined();
          if (!firstChild) continue;
          expect(
            firstChild.kind,
            counterexample(
              "P6: Tool continuation placement",
              log,
              result,
              `First child is ${firstChild.kind} for U(${node.entry.sequenceNumber})`,
            ),
          ).not.toBe("tool-continuation");
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P7: tool continuation tools match the preceding ai-response tools", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        for (const node of getUserMessageNodes(result)) {
          for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            expect(
              child,
              counterexample(
                "P7: Tool provenance",
                log,
                result,
                `Missing child at index ${i} for U(${node.entry.sequenceNumber})`,
              ),
            ).toBeDefined();
            if (child?.kind !== "tool-continuation") continue;

            let precedingAI:
              | Extract<TreeChild, { kind: "ai-response" }>
              | undefined;
            for (let j = i - 1; j >= 0; j--) {
              const candidate = node.children[j];
              if (!candidate) continue;
              if (candidate.kind === "ai-response") {
                precedingAI = candidate;
                break;
              }
            }

            expect(
              precedingAI,
              counterexample(
                "P7: Tool provenance",
                log,
                result,
                `No preceding AI for tool continuation at index ${i}`,
              ),
            ).toBeDefined();

            if (!precedingAI) continue;

            expect(
              child.tools,
              counterexample(
                "P7: Tool provenance",
                log,
                result,
                `TC tools=${JSON.stringify(child.tools)} vs AI tools=${JSON.stringify(
                  precedingAI.tools,
                )}`,
              ),
            ).toEqual(precedingAI.tools);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P8: top-level nodes are in reverse chronological order", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);

        const ordered = result.topLevel.filter((n) => n.kind !== "history");
        const indices = ordered.map((node) => {
          if (node.kind === "user-message") return windowed.indexOf(node.entry);
          if (node.kind === "compaction") return windowed.indexOf(node.entry);
          return windowed.indexOf(node.entry);
        });

        for (let i = 0; i < indices.length; i++) {
          const current = indices[i];
          expect(
            current,
            counterexample(
              "P8: Reverse-chronological ordering",
              log,
              result,
              `Missing source index for top-level node at ${i}`,
            ),
          ).toBeDefined();
          if (current === undefined) continue;
          expect(
            current,
            counterexample(
              "P8: Reverse-chronological ordering",
              log,
              result,
              `Missing source index for top-level node at ${i}`,
            ),
          ).toBeGreaterThanOrEqual(0);
        }

        for (let i = 1; i < indices.length; i++) {
          const current = indices[i];
          const previous = indices[i - 1];
          expect(
            current,
            counterexample(
              "P8: Reverse-chronological ordering",
              log,
              result,
              `Top-level indices not descending: ${indices.join(", ")}`,
            ),
          ).toBeDefined();
          expect(
            previous,
            counterexample(
              "P8: Reverse-chronological ordering",
              log,
              result,
              `Top-level indices not descending: ${indices.join(", ")}`,
            ),
          ).toBeDefined();
          if (current === undefined || previous === undefined) continue;
          expect(
            current,
            counterexample(
              "P8: Reverse-chronological ordering",
              log,
              result,
              `Top-level indices not descending: ${indices.join(", ")}`,
            ),
          ).toBeLessThan(previous);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P9: children within a group preserve input order", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);

        for (const node of getUserMessageNodes(result)) {
          const indices = node.children
            .filter((c) => c.kind !== "tool-call")
            .map((c) => windowed.indexOf((c as any).entry));
          for (let i = 0; i < indices.length; i++) {
            const current = indices[i];
            expect(
              current,
              counterexample(
                "P9: Chronological children",
                log,
                result,
                `Missing source index for child ${i} of U(${node.entry.sequenceNumber})`,
              ),
            ).toBeDefined();
            if (current === undefined) continue;
            expect(
              current,
              counterexample(
                "P9: Chronological children",
                log,
                result,
                `Missing source index for child ${i} of U(${node.entry.sequenceNumber})`,
              ),
            ).toBeGreaterThanOrEqual(0);
          }
          for (let i = 1; i < indices.length; i++) {
            const current = indices[i];
            const previous = indices[i - 1];
            expect(
              current,
              counterexample(
                "P9: Chronological children",
                log,
                result,
                `Child indices not ascending: ${indices.join(", ")}`,
              ),
            ).toBeDefined();
            expect(
              previous,
              counterexample(
                "P9: Chronological children",
                log,
                result,
                `Child indices not ascending: ${indices.join(", ")}`,
              ),
            ).toBeDefined();
            if (current === undefined || previous === undefined) continue;
            expect(
              current,
              counterexample(
                "P9: Chronological children",
                log,
                result,
                `Child indices not ascending: ${indices.join(", ")}`,
              ),
            ).toBeGreaterThan(previous);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P10: windowActivityLog partitions entries exactly once", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed, history } = windowActivityLog(log);
        const result = buildTree(log);

        const windowedSet = new Set(windowed);
        const historySet = new Set(history);

        for (const entry of log) {
          const inWindow = windowedSet.has(entry);
          const inHistory = historySet.has(entry);

          expect(
            inWindow || inHistory,
            counterexample(
              "P10: Partition completeness",
              log,
              result,
              "Entry appears in neither partition",
            ),
          ).toBe(true);

          expect(
            inWindow && inHistory,
            counterexample(
              "P10: Partition completeness",
              log,
              result,
              "Entry appears in both partitions",
            ),
          ).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P11: ai-response, tool-continuation, and grouped errors appear in exactly one group", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);

        const seen = new Set<ActivityLogEntry>();
        for (const node of getUserMessageNodes(result)) {
          for (const child of node.children) {
            // Skip tool-calls (derived from AIResponseEntry.toolCalls)
            if (child.kind === "tool-call") continue;
            const entry = (child as any).entry;
            const entryId = formatEntryId(entry);
            expect(
              seen.has(entry),
              counterexample(
                "P11: Exclusive grouping",
                log,
                result,
                `Duplicate child entry ${entry.type} ${entryId}`,
              ),
            ).toBe(false);
            seen.add(entry);
          }
        }

        for (let i = 0; i < windowed.length; i++) {
          const entry = windowedAt(windowed, i);
          let shouldBeGrouped = false;
          if (entry.type === "ai-response") {
            shouldBeGrouped = true;
          } else if (
            entry.type === "user-message" &&
            entry.isToolContinuation
          ) {
            shouldBeGrouped = true;
          } else if (entry.type === "error") {
            for (let j = i - 1; j >= 0; j--) {
              const candidate = windowedAt(windowed, j);
              if (isActualUserMessage(candidate)) {
                shouldBeGrouped = true;
                break;
              }
            }
          }

          if (!shouldBeGrouped) continue;

          expect(
            seen.has(entry),
            counterexample(
              "P11: Exclusive grouping",
              log,
              result,
              `Grouped entry missing from any group: ${entry.type}`,
            ),
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P12: groups start only at actual user messages", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);

        const actuals = windowed.filter((e) => isActualUserMessage(e));
        const actualSet = new Set(actuals);
        const groups = getUserMessageNodes(result);

        expect(
          groups.length,
          counterexample(
            "P12: Group boundary rule",
            log,
            result,
            `Expected ${actuals.length} groups, got ${groups.length}`,
          ),
        ).toBe(actuals.length);

        for (const node of groups) {
          expect(
            isActualUserMessage(node.entry),
            counterexample(
              "P12: Group boundary rule",
              log,
              result,
              `Group entry is not actual user message: ${node.entry.sequenceNumber}`,
            ),
          ).toBe(true);

          expect(
            actualSet.has(node.entry),
            counterexample(
              "P12: Group boundary rule",
              log,
              result,
              `Group entry not found in windowed actuals: ${node.entry.sequenceNumber}`,
            ),
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P13: topLevel includes at most WINDOW_SIZE user-message nodes", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        expect(getUserMessageNodes(result).length).toBeLessThanOrEqual(
          WINDOW_SIZE,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P14: history node exists iff more than WINDOW_SIZE actual user messages", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        const actualCount = log.filter((e) => isActualUserMessage(e)).length;
        const hasHistory = result.topLevel.some((n) => n.kind === "history");

        if (actualCount > WINDOW_SIZE) {
          expect(
            hasHistory,
            counterexample(
              "P14: History existence",
              log,
              result,
              `${actualCount} actual user messages but no history node`,
            ),
          ).toBe(true);
        } else {
          expect(
            hasHistory,
            counterexample(
              "P14: History existence",
              log,
              result,
              `${actualCount} actual user messages but history node exists`,
            ),
          ).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P15: no user message group is split across window and history", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed, history } = windowActivityLog(log);
        const result = buildTree(log);

        const windowedSet = new Set(windowed);
        const historySet = new Set(history);
        const groups: ActivityLogEntry[][] = [];
        let current: ActivityLogEntry[] | null = null;

        for (const entry of log) {
          if (isActualUserMessage(entry)) {
            if (current) groups.push(current);
            current = [entry];
          } else if (
            entry.type === "ai-response" ||
            entry.type === "error" ||
            ("isToolContinuation" in entry && entry.isToolContinuation)
          ) {
            if (current) current.push(entry);
          }
        }
        if (current) groups.push(current);

        for (const group of groups) {
          const inWindow = group.filter((e) => windowedSet.has(e)).length;
          const inHistory = group.filter((e) => historySet.has(e)).length;
          if (inWindow > 0 && inHistory > 0) {
            expect(
              false,
              counterexample(
                "P15: Group atomicity",
                log,
                result,
                `Group split across window/history: ${inWindow} in window, ${inHistory} in history`,
              ),
            ).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P16: compaction entries are always top-level", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);

        const compactionEntries = new Set<ActivityLogEntry>(
          windowed.filter((e): e is CompactionEntry => e.type === "compaction"),
        );

        for (const node of getUserMessageNodes(result)) {
          const hasCompactionChild = node.children.some(
            (c) =>
              c.kind !== "tool-call" && compactionEntries.has((c as any).entry),
          );
          expect(
            hasCompactionChild,
            counterexample(
              "P16: Compaction is top-level",
              log,
              result,
              `Compaction found as child of U(${node.entry.sequenceNumber})`,
            ),
          ).toBe(false);
        }

        for (const entry of windowed) {
          if (entry.type !== "compaction") continue;
          const exists = result.topLevel.some(
            (n) => n.kind === "compaction" && n.entry === entry,
          );
          expect(
            exists,
            counterexample(
              "P16: Compaction is top-level",
              log,
              result,
              "Compaction missing from top level",
            ),
          ).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P17: compaction ordering is preserved relative to windowed groups", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const { windowed } = windowActivityLog(log);
        const result = buildTree(log);

        const topLevel = result.topLevel.filter((n) => n.kind !== "history");
        const topLevelIndex = new Map<TreeNode, number>();
        for (let i = 0; i < topLevel.length; i++) {
          const node = topLevel[i];
          expect(
            node,
            counterexample(
              "P17: Compaction ordering",
              log,
              result,
              `Missing top-level node at index ${i}`,
            ),
          ).toBeDefined();
          if (!node) continue;
          topLevelIndex.set(node, i);
        }

        const compactions = topLevel.filter(
          (n): n is Extract<TreeNode, { kind: "compaction" }> =>
            n.kind === "compaction",
        );

        const groups = topLevel.filter(
          (n): n is Extract<TreeNode, { kind: "user-message" }> =>
            n.kind === "user-message",
        );

        for (const compactionNode of compactions) {
          const compactionSource = windowed.indexOf(compactionNode.entry);
          for (const group of groups) {
            const groupSource = windowed.indexOf(group.entry);
            const shouldComeFirst = compactionSource > groupSource;
            const compPos = topLevelIndex.get(compactionNode);
            const groupPos = topLevelIndex.get(group);
            expect(
              compPos,
              counterexample(
                "P17: Compaction ordering",
                log,
                result,
                `Missing top-level index for compaction ${compactionSource}`,
              ),
            ).toBeDefined();
            expect(
              groupPos,
              counterexample(
                "P17: Compaction ordering",
                log,
                result,
                `Missing top-level index for group ${groupSource}`,
              ),
            ).toBeDefined();
            if (compPos === undefined || groupPos === undefined) continue;

            expect(
              compPos < groupPos,
              counterexample(
                "P17: Compaction ordering",
                log,
                result,
                `Compaction index ${compactionSource} vs group index ${groupSource}`,
              ),
            ).toBe(shouldComeFirst);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P18: compaction does not count toward the window size", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);
        const actualCount = log.filter((e) => isActualUserMessage(e)).length;
        const expected = Math.min(actualCount, WINDOW_SIZE);

        expect(
          getUserMessageNodes(result).length,
          counterexample(
            "P18: Compaction does not count",
            log,
            result,
            `Expected ${expected} user-message nodes`,
          ),
        ).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P19: all toolCalls in AIResponseEntry map to tool-call children", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);

        // Collect all AIResponseEntry instances with toolCalls
        const aiEntriesWithTools = new Map<AIResponseEntry, number>();
        for (const node of getUserMessageNodes(result)) {
          for (const child of node.children) {
            if (child.kind === "ai-response" && child.entry.toolCalls) {
              aiEntriesWithTools.set(child.entry, child.entry.toolCalls.length);
            }
          }
        }

        // Verify each AI response's tool calls appear as tool-call children
        for (const node of getUserMessageNodes(result)) {
          for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            if (child?.kind !== "ai-response") continue;

            const expectedToolCount = child.entry.toolCalls?.length ?? 0;
            if (expectedToolCount === 0) continue;

            // Count tool-call children immediately following this AI response
            let toolCallCount = 0;
            for (let j = i + 1; j < node.children.length; j++) {
              const nextChild = node.children[j];
              if (!nextChild) continue;
              if (nextChild.kind === "tool-call") {
                toolCallCount++;
              } else {
                // Stop counting at first non-tool-call
                break;
              }
            }

            expect(
              toolCallCount,
              counterexample(
                "P19: Tool calls as children",
                log,
                result,
                `AI response A(${child.entry.sequenceNumber}) has ${expectedToolCount} toolCalls but ${toolCallCount} tool-call children`,
              ),
            ).toBe(expectedToolCount);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("P20: tool calls appear before tool continuations in user message group", () => {
    fc.assert(
      fc.property(arbActivityLog, (log) => {
        const result = buildTree(log);

        for (const node of getUserMessageNodes(result)) {
          let lastToolCallIndex = -1;
          let firstToolContinuationIndex = -1;

          for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            if (!child) continue;

            if (child.kind === "tool-call") {
              lastToolCallIndex = i;
            } else if (
              child.kind === "tool-continuation" &&
              firstToolContinuationIndex === -1
            ) {
              firstToolContinuationIndex = i;
            }
          }

          if (lastToolCallIndex >= 0 && firstToolContinuationIndex >= 0) {
            expect(
              lastToolCallIndex < firstToolContinuationIndex,
              counterexample(
                "P20: Tool call ordering",
                log,
                result,
                `Tool calls come after tool continuations in U(${node.entry.sequenceNumber})`,
              ),
            ).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
