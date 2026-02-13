# Proposed API Priority Model

Companion to [`vscode-api-horizon.ts`](./vscode-api-horizon.ts). The scanner
measures **timeline** (when is it landing?). This document defines the
**value assessment** (what does it buy us?) and the **decision function**
that combines both into an action priority.

## Dimensions

### 1. Value Type

| Type | Definition | Example |
|------|-----------|---------|
| **Integration** | Makes us visible through VS Code's own UI with zero feature work. Free UX. | Token widget reporting, native thinking display, tool progress UI |
| **Correctness** | Fixes bugs or eliminates fragile assumptions. Split into *fragile* (relying on undocumented behavior that could break any release) vs *imprecise* (heuristic that's good enough). | System prompt role detection, stateful-marker DataPart persistence |
| **Feature** | Enables something users would notice that we can't do today (or can only hack around). | Session persistence, chat context providers, MCP gateway |
| **Streamline** | Removes workarounds, simplifies code, reduces maintenance surface. | Replacing manual type-guards with stable types |

### 2. Entanglement

| Level | Definition |
|-------|-----------|
| **Core** | Deeply woven into provider/streaming/translation — adoption requires coordinated changes |
| **Orthogonal** | Can be adopted independently, feature-flag friendly |

For **core-entangled features**, there's a further split:

- **Entangled in code** → wait for stability before adopting
- **Entangled in design** → factor into interface design *now*, even without adopting

### 3. Timeline

From the scanner's readiness score:

| Tier | Score | Horizon |
|------|-------|---------|
| Imminent | 85+ or has `api-finalization` label | 1–2 releases |
| Near | 70–84 | 1–3 months |
| Mid | 55–69 | 3–6 months |
| Long | 40–54 | 6–12 months |
| Indefinite | <40 | No clear path |

## Decision Function

```
PRIORITY(proposal) =

  if value == integration:
    if timeline <= mid:     → PREPARE NOW (free UX)
    else:                   → WATCH

  if value == correctness:
    if fragility == high:   → PREPARE NOW (carrying risk, not just debt)
    if timeline <= near:    → PREPARE NOW
    else:                   → WATCH (debt, not risk)

  if value == feature:
    if entanglement == orthogonal:
      if timeline <= mid:   → EXPERIMENTAL TRACK
      else:                 → WATCH
    if entanglement == core:
      → DESIGN AWARENESS (factor into interfaces, don't adopt)

  if value == streamline:
    if timeline <= near:    → PREPARE NOW (low effort, soon)
    else:                   → IGNORE (not worth the abstraction)
```

### Action categories

| Action | Meaning |
|--------|---------|
| **PREPARE NOW** | Build the abstraction layer or wire-up so we're ready on day one |
| **EXPERIMENTAL TRACK** | Prototype behind a flag; adopt when stable |
| **DESIGN AWARENESS** | Don't adopt, but ensure our interfaces don't fight it |
| **WATCH** | Track in scanner output, revisit next quarter |
| **IGNORE** | Not worth attention at current timeline |

## Rationale for key rules

**Integration gets its own fast lane.** Integration items are the *only*
category where the user perceives value with zero feature work from us.
Token widget, thinking display, tool progress — these are free UX if we
wire them up.

**Correctness splits on fragility, not annoyance.** A heuristic that's
"good enough" is debt. Relying on undocumented behavior that could break
any release is *risk*. Risk gets priority regardless of timeline.

**Core-entangled features produce "design awareness", not "lower priority".**
You don't need to *adopt* `chatSessionsProvider` today. But if your
interfaces are designed without awareness that session persistence is
coming, you'll build abstractions that fight it later. This is the core
insight of RFC 00066 — using proposals as design signals.

**Streamline stays low priority unless it's landing soon.** Simplifying
code that works is nice but not urgent. If the stable API is months away,
the workaround is fine.
