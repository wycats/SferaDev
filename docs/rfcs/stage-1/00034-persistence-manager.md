---
title: Persistence Manager
stage: 1
feature: infrastructure
exo:
  tool: exo rfc create
  protocol: 1
---

# RFC 00034: Persistence Manager

## Problem Statement

The codebase has multiple ad-hoc persistence patterns:

| Component              | Storage         | Key                                 | Data Shape               | Versioning             |
| ---------------------- | --------------- | ----------------------------------- | ------------------------ | ---------------------- |
| ModelsClient           | globalState     | `vercelAiGateway.modelsCache`       | `PersistentModelsCache`  | Legacy fallback only   |
| ModelEnricher          | globalState     | `vercelAiGateway.enrichmentCache`   | `{ version, entries }`   | Internal version field |
| ~~CalibrationManager~~ | ~~globalState~~ | ~~`tokenEstimator.calibrations`~~   | ~~`CalibrationState[]`~~ | **REMOVED** (RFC 029)  |
| AuthProvider           | globalState     | `vercelAiGateway.activeSession`     | `string \| null`         | None                   |
| Provider               | workspaceState  | `vercelAiGateway.lastSelectedModel` | `string`                 | None                   |

**Source locations:**

- Models: [src/models.ts](apps/vscode-ai-gateway/src/models.ts) — `MODELS_CACHE_KEY`, `PersistentModelsCache`
- Enrichment: [src/models/enrichment.ts](apps/vscode-ai-gateway/src/models/enrichment.ts) — `ENRICHMENT_CACHE_KEY`
- ~~Calibration~~: **Removed** — RFC 029 simplified to delta-only estimation, no calibration persistence needed
- Auth: [src/auth.ts](apps/vscode-ai-gateway/src/auth.ts) — session ID only; tokens use SecretStorage (out of scope)
- LastModel: [src/provider.ts](apps/vscode-ai-gateway/src/provider.ts) — `LAST_SELECTED_MODEL_KEY`

**Note on SecretStorage**: AuthProvider stores session ID in globalState but actual tokens/credentials in VS Code's `SecretStorage` API. SecretStorage is explicitly **out of scope** for this RFC as it has different security semantics.

Problems:

1. **No unified interface** — Each component implements its own persistence logic
2. **Inconsistent versioning** — Only enrichment has version envelope; others have none
3. **No LRU/cleanup** — Enrichment cache grows unbounded per model
4. **No scoping abstraction** — Components hardcode globalState vs workspaceState
5. **No type safety** — Keys are magic strings, values are `unknown`
6. **Inconsistent key naming** — `tokenEstimator.calibrations` lacks extension prefix
7. **Serialization hazards** — VS Code model objects aren't serializable; must store raw data

## Goals

1. Unified persistence interface with type-safe keys and values
2. Automatic schema versioning with migration support
3. Configurable scoping (global, workspace, session-aggregate)
4. Optional TTL and LRU eviction for cache-like data
5. Testability — easy to mock in unit tests

## Non-Goals

1. Persist conversation identity (explicitly out of scope per RFC 00033)
2. Cross-window synchronization
3. Cloud sync or backup
4. SecretStorage wrapping (auth tokens use VS Code's SecretStorage API which has different security semantics)

## Proposed Solution

### Core Interface

```typescript
interface PersistenceManager {
  /**
   * Get a scoped store for a specific data type.
   * Type parameter ensures compile-time safety.
   */
  getStore<T>(config: StoreConfig<T>): PersistentStore<T>;

  /**
   * Clear all persisted data (for testing/reset).
   */
  clearAll(): Promise<void>;
}

interface StoreConfig<T> {
  /** Unique key for this store */
  key: string;

  /** Schema version — increment when T changes */
  version: number;

  /** Scope determines which VS Code storage is used */
  scope: "global" | "workspace";

  /** Default value when store is empty or version mismatch */
  defaultValue: T;

  /** Optional: migrate from previous version */
  migrate?: (oldValue: unknown, oldVersion: number) => T;

  /** Optional: TTL in milliseconds (for cache-like stores) */
  ttlMs?: number;

  /** Optional: max entries (for LRU eviction) */
  maxEntries?: number;

  /** Optional: legacy keys to read from (for key migration) */
  legacyKeys?: string[];
}

interface PersistentStore<T> {
  /** Get current value (returns default if empty/expired/invalid) */
  get(): T;

  /** Set value (persists immediately) */
  set(value: T): Promise<void>;

  /** Update value with transform function */
  update(fn: (current: T) => T): Promise<void>;

  /** Clear this store only */
  clear(): Promise<void>;

  /** Check if store has valid (non-default) data */
  hasData(): boolean;
}
```

### Scoping Model

| Scope       | VS Code API              | Survives                  | Use Case                      |
| ----------- | ------------------------ | ------------------------- | ----------------------------- |
| `global`    | `context.globalState`    | Restart, workspace change | User preferences, model cache |
| `workspace` | `context.workspaceState` | Restart                   | Project-specific settings     |

### Versioning Strategy

Stored format:

```typescript
interface StoredEnvelope<T> {
  version: number;
  timestamp: number;
  data: T;
}
```

On read:

1. If version matches → return data
2. If version mismatch and `migrate` provided → migrate and persist
3. If version mismatch and no `migrate` → return defaultValue (data discarded)

### TTL Strategies

Two TTL patterns exist in the codebase:

| Pattern             | Example       | Behavior                                                     |
| ------------------- | ------------- | ------------------------------------------------------------ |
| **Store-level TTL** | ModelsClient  | Entire cache expires; `fetchedAt` checked on read            |
| **Per-entry TTL**   | ModelEnricher | Each entry has `fetchedAt`; expired entries filtered on read |

The `StoreConfig.ttlMs` applies store-level TTL. For per-entry TTL, the store value must include timestamps and the consumer handles filtering.

### LRU Eviction (for cache stores)

When `maxEntries` is set and store value is a Record or array:

- On `set()`, if entries exceed max, evict oldest by timestamp
- Requires stored data to include timestamps per entry
- Enrichment cache is primary candidate (grows per unique model)

### Negative Caching

ModelEnricher caches `null` for 404 responses to avoid repeated failed lookups. The persistence layer should preserve `null` values (not treat them as "empty").

### Serialization Constraints

**Critical**: VS Code model objects (`vscode.LanguageModelChat`) are not serializable. ModelsClient stores `rawModels` (API response) and rehydrates on read. All stores must use serializable data only.

## Concrete Store Configs

### ModelsCache

```typescript
/**
 * Matches PersistentModelsCache in src/models.ts
 * Note: `models` field is stored but re-transformed on load from rawModels.
 * We only persist the serializable subset.
 */
interface ModelsCacheData {
  fetchedAt: number;
  etag: string | null;
  rawModels: Model[]; // API response, NOT vscode.LanguageModelChat
  // Note: actual PersistentModelsCache also has `models: LanguageModelChatInformation[]`
  // but this is re-derived from rawModels on load, so we don't include it in the store config
}

const MODELS_CACHE_STORE: StoreConfig<ModelsCacheData> = {
  key: "vercelAiGateway.modelsCache",
  version: 2,
  scope: "global",
  defaultValue: { fetchedAt: 0, etag: null, rawModels: [] },
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours
  migrate: (old, v) => {
    // v1 had `models` field with non-serializable objects
    if (v === 1 && old && typeof old === "object" && "rawModels" in old) {
      return old as ModelsCacheData;
    }
    return { fetchedAt: 0, etag: null, rawModels: [] };
  },
};
```

### EnrichmentCache

```typescript
interface EnrichmentEntry {
  fetchedAt: number;
  data: EnrichedModelData | null; // null = 404 cached
}

interface EnrichmentCacheData {
  entries: Record<string, EnrichmentEntry>;
}

const ENRICHMENT_CACHE_STORE: StoreConfig<EnrichmentCacheData> = {
  key: "vercelAiGateway.enrichmentCache",
  version: 2,
  scope: "global",
  defaultValue: { entries: {} },
  maxEntries: 200, // LRU eviction for unbounded growth
  migrate: (old, v) => {
    // v1 had internal version wrapper
    if (old && typeof old === "object") {
      const o = old as Record<string, unknown>;
      if ("entries" in o)
        return { entries: o.entries as Record<string, EnrichmentEntry> };
    }
    return { entries: {} };
  },
};
```

### CalibrationState

```typescript
/**
 * Matches CalibrationState in src/tokens/calibration-manager.ts
 * Uses EMA (exponential moving average) - does NOT store individual samples.
 */
interface CalibrationState {
  /** Model family identifier (e.g., "claude", "gpt-4") */
  modelFamily: string;
  /** EMA of actual/estimated ratios */
  correctionFactor: number;
  /** Number of calibration samples (count, not array) */
  sampleCount: number;
  /** Timestamp of last calibration */
  lastCalibrated: number;
  /** Recent deviation from predictions (0-1) */
  drift: number;
}

const CALIBRATION_STORE: StoreConfig<CalibrationState[]> = {
  key: "vercelAiGateway.calibrations", // Normalize key prefix from tokenEstimator.calibrations
  version: 1,
  scope: "global",
  defaultValue: [],
  legacyKeys: ["tokenEstimator.calibrations"], // Read from old key, write to new
  migrate: (old) => (Array.isArray(old) ? old : []),
};
```

### ActiveSession

```typescript
const ACTIVE_SESSION_STORE: StoreConfig<string | null> = {
  key: "vercelAiGateway.activeSession",
  version: 1,
  scope: "global",
  defaultValue: null,
};
```

### LastSelectedModel

```typescript
const LAST_SELECTED_MODEL_STORE: StoreConfig<string | null> = {
  key: "vercelAiGateway.lastSelectedModel",
  version: 1,
  scope: "workspace",
  defaultValue: null,
};
```

### SessionStats (new)

```typescript
interface SessionStats {
  timestamp: number;
  agentCount: number;
  mainAgentTurns: number;
  totalInputTokens: number; // Max context reached
  totalOutputTokens: number; // Accumulated output
  modelId: string | null;
}

const SESSION_STATS_STORE: StoreConfig<SessionStats> = {
  key: "vercelAiGateway.sessionStats",
  version: 1,
  scope: "global",
  defaultValue: {
    timestamp: 0,
    agentCount: 0,
    mainAgentTurns: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    modelId: null,
  },
};
```

### Migration Path

Existing persistence code can be migrated incrementally:

1. **Phase 1**: Create PersistenceManager, define store configs
2. **Phase 2**: Migrate ModelsClient and ModelEnricher (highest value)
3. **Phase 3**: Migrate CalibrationManager and AuthProvider
4. **Phase 4**: Add new SessionStats store for Option B feature

Existing keys are preserved — the manager wraps them in versioned envelopes.

## Implementation Notes

### File Structure

```
src/
  persistence/
    index.ts              # Public API
    manager.ts            # PersistenceManager implementation
    store.ts              # PersistentStore implementation
    types.ts              # Interfaces and store configs
    migration.ts          # Version migration utilities
```

### Testing

```typescript
// Mock for unit tests
const mockPersistence = createMockPersistenceManager();
mockPersistence.getStore(MODEL_CACHE_STORE).set(testData);
```

### Error Handling

- Corrupted data → log warning, return defaultValue
- Storage quota exceeded → log error, operation fails gracefully
- Migration failure → log error, return defaultValue

## Alternatives Considered

### 1. Keep ad-hoc persistence

- Pro: No migration effort
- Con: Continued fragmentation, no versioning

### 2. Use a third-party library (e.g., keyv)

- Pro: Battle-tested
- Con: Adds dependency, may not fit VS Code's storage model

### 3. SQLite via better-sqlite3

- Pro: Powerful queries, transactions
- Con: Native dependency, overkill for our needs

## VS Code API Constraints

From the [VS Code Memento API](https://code.visualstudio.com/api/references/vscode-api#Memento):

- `Memento` exposes `get(key, defaultValue)`, `update(key, value)`, and `keys()`
- Updates are async (`Thenable<void>`) — some existing code ignores the promise
- `globalState` supports `setKeysForSync()` for cross-machine sync (not currently used)
- For large data (>1MB), prefer `storageUri`/`globalStorageUri` file storage
- For secrets, use `SecretStorage` API instead

**Gotcha**: Existing calibration persistence uses `void` cast on update, risking data loss on shutdown. The manager should await all writes.

## Implementation Considerations

### Async Write Handling

Current code often ignores the async nature of `update()`:

```typescript
// Current (risky)
void this.globalState.update(key, value);

// With manager (safe)
await store.set(value);
```

The manager should:

1. Always await writes internally
2. Optionally batch writes with debouncing for high-frequency updates
3. Flush pending writes on extension deactivation

### Multi-Window Behavior

`globalState` is per-extension, not per-window. Multiple VS Code windows share the same storage. The manager should:

1. Document this behavior
2. Consider read-before-write for conflict-prone stores
3. SessionStats should use "last writer wins" (acceptable for aggregate stats)

### Key Migration

The `tokenEstimator.calibrations` key lacks the `vercelAiGateway.` prefix. Migration options:

1. **Rename on first access** — Read old key, write to new key, delete old
2. **Keep legacy key** — Less churn, but inconsistent
3. **Support key aliases** — `StoreConfig.legacyKeys?: string[]`

Recommendation: Option 3 (aliases) for backward compatibility.

## Open Questions

1. ~~Should `maxEntries` apply to the store value itself?~~ **Resolved**: Yes, for Record-typed stores. Consumer provides timestamp field name.

2. Should we support async migrations for expensive transformations? **Leaning no** — migrations should be fast; expensive work belongs in application code.

3. ~~Should workspace-scoped stores have a "project identifier"?~~ **Resolved**: No — VS Code handles this via separate workspaceState per workspace.

4. **NEW**: Should we implement `setKeysForSync()` for any stores? Candidates: `lastSelectedModel` (user preference).

## References

- [VS Code Extension Storage API](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage)
- [VS Code Memento API](https://code.visualstudio.com/api/references/vscode-api#Memento)
- RFC 00033: Conversation Identity Tracking (non-goal: no persistence of identity)
- RFC 008: High-Fidelity Model Mapping (uses globalState for enrichment cache)
