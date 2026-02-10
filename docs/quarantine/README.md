# Quarantined Documents

These documents contain analysis or findings that **have not been empirically re-validated** against the current codebase. The codebase has undergone major refactoring (identity system overhaul, removal of forensic capture, removal of old estimation infrastructure) and conclusions in these documents may be wrong.

**Do not cite these as authoritative.** If you need information from them, verify against the actual code first.

## Contents

- **COPILOT_CORRELATION_ANALYSIS.md** — Describes Copilot's loopback correlation pattern (`CapturingToken`). Probably still accurate as a description of Copilot internals, but unverified.
- **NATIVE_TOKEN_WIDGET_GAP.md** — Claims the native token widget can't be populated by LM providers. Probably still true but needs verification against current VS Code proposed APIs.
- **CODEX_5X_VSCODE_ALIGNMENT.md** — Research about Codex 5.x model family support. Forward-looking; needs validation that recommendations still apply.
