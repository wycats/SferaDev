# Exo CLI Issues: epoch add & idea add

**Date**: 2026-02-14
**Reporter**: AI agent (via MCP tool + terminal)

## Summary

Two issues encountered when creating an epoch and adding ideas via the exo CLI.

## Issue 1: `epoch add` not recognized via MCP tool

### Steps

1. Tried `exo epoch add proposed-api-alignment --label "..."` via MCP tool → error
2. Tried `exo epoch add proposed-api-alignment --title "..."` via MCP tool → error
3. Tried `exo epoch add proposed-api-alignment` (positional) via MCP tool → error
4. Tried `exo epoch add --id proposed-api-alignment --label $1` with args via MCP tool → error

All returned: `Error: Invalid call (failed to compile to an invocation)`

### Recovery

Ran `exo epoch add --help` in the terminal to discover the actual syntax:

```
Usage: exo epoch add [OPTIONS] --title <TITLE>
```

Then ran directly in the terminal:

```bash
exo epoch add -t "Proposed API Alignment"
# → Added epoch '01khetjx8p8yawtehsa3c264ck': Proposed API Alignment
```

### Root Cause (suspected)

The MCP tool wrapper for `epoch add` doesn't compile valid invocations. The `--title` flag is required but the MCP tool couldn't construct the call. Possibly `epoch add` isn't wired into the MCP `invoke_json` dispatch (`exo-run` tool).

---

## Issue 2: `idea add` panics in terminal, fails in MCP without `--title`

### Steps (terminal)

1. Ran in terminal:

```bash
exo idea add -t "Replace ad-hoc status bar..." -d "description..." -g proposed-api-alignment
```

**Result**: Panic

```
thread 'main' panicked at tools/exo/src/main.rs:1445:14:
internal error: entered unreachable code: command dispatched via invoke_json
```

2. Retried without `-g` flag:

```bash
exo idea add -t "Replace ad-hoc status bar..." -d "description..."
```

**Result**: Same panic. The `-d` and/or the terminal dispatch path triggers the crash.

### Steps (MCP tool)

3. Tried via MCP tool:

```
exo-run("idea add -t \"...\"")
```

**Result**: `Error: Invalid call (failed to compile to an invocation)`

4. Tried via MCP tool with `$1` arg placeholder:

```
exo-run("idea add --title $1", args=["Replace ad-hoc status bar..."])
```

**Result**: Success!

### Recovery

Used the MCP tool with `$1` placeholder syntax for all three ideas:

```
exo-run("idea add --title $1", args=["idea text here"])
```

All three succeeded.

### Root Cause (suspected)

1. **Terminal panic**: `idea add` from the terminal (not via MCP) hits `command dispatched via invoke_json` unreachable code at `main.rs:1445`. Possibly the terminal path incorrectly routes through the JSON dispatch. The `-g`/`-d` flags don't seem related — the panic happens with just `-t` too.

2. **MCP without $1**: The MCP tool can't compile `idea add -t "..."` with inline quoted strings. Using `$1` placeholder args works.

---

## Workaround Summary

| Operation                    | Terminal | MCP (inline)        | MCP ($1 args) |
| ---------------------------- | -------- | ------------------- | ------------- |
| `epoch add -t "..."`         | ✅ Works | ❌ Fails to compile | Not tried     |
| `idea add -t "..."`          | ❌ Panic | ❌ Fails to compile | ✅ Works      |
| `idea add -t "..." -d "..."` | ❌ Panic | Not tried           | Not tried     |
| `idea add -t "..." -g tag`   | ❌ Panic | Not tried           | Not tried     |
