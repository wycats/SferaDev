---
applyTo: "**/*.test.ts,**/*.test-helpers.ts"
---

# Testing: Mock Reduction Policy

This is a **living document**. Update the counts and tables below whenever you
complete work that changes the mock landscape. The goal is monotonic reduction —
the behavioral mock count should only go down over time.

## The Rule

**No new behavioral mocks.** When you touch a test file that has behavioral
mocks, extract an interface at the production boundary and convert the mock to
a test helper that implements the interface.

### What counts as a behavioral mock?

A `vi.mock()` whose return values or call records are referenced in `expect()`
assertions, or whose `mockReturnValue`/`mockImplementation` drives
test-specific behavior.

### What doesn't count?

**Import-satisfaction mocks** — mocks that exist solely to prevent import
errors (e.g., mocking `vscode` so the module loads in Node, mocking `logger`
to suppress output). These are not asserted on and don't couple tests to
implementation details. They're still undesirable (they indicate a missing
interface boundary) but they're not the priority.

## Current Counts (2026-02-16)

| Metric                    | Count |
| ------------------------- | ----- |
| Test files with any mocks | 35    |
| **Behavioral mocks**      | **43**|
| Import-satisfaction mocks | 19    |
| Total `vi.mock()` calls   | 62    |

## Top Offenders (behavioral mocks, descending)

| File                                    | Behavioral | Import-sat | Pattern to extract                    |
| --------------------------------------- | ---------- | ---------- | ------------------------------------- |
| `provider/openresponses-chat.test.ts`   | 9          | 0          | HTTP client, stream adapter, retry    |
| `logger/investigation.test.ts`          | 4          | 0          | fs, child_process, vscode config      |
| `vercel-auth.test.ts`                   | 3          | 0          | fs, os (file system reads)            |
| `provider/request-builder.test.ts`      | 2          | 1          | vscode config, system-prompt          |
| `logger/error-capture.test.ts`          | 2          | 1          | fs (file writes)                      |
| `provider/stream-adapter-errors.test.ts`| 2          | 1          | vscode, logger                        |
| `auth.test.ts`                          | 2          | 0          | vscode, vercel-auth                   |

## Recently Converted

| File                                  | Date       | Before → After | Technique                          |
| ------------------------------------- | ---------- | -------------- | ---------------------------------- |
| `logger/unified-log-subscriber.test.ts` | 2026-02-16 | 3 → 0 behavioral | EventWriter + LogConfig interfaces |

## The JIT Pattern

Don't go on a mock-elimination crusade. Instead:

1. **When you touch a file with behavioral mocks** — extract an interface,
   create a test helper, convert the mocks. Update the counts above.
2. **When you create a new test file** — use interfaces from the start.
   No behavioral mocks allowed in new test files.
3. **When you see an import-satisfaction mock** — note it, but don't
   prioritize converting it unless you're already refactoring that boundary.

The interface should live next to the production code (e.g.,
`unified-log-subscriber.ts` exports `EventWriter`). The test helper should
live next to the test (e.g., `unified-log-subscriber.test-helpers.ts`).
