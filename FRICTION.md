# FRICTION.md: Exo Bootstrap Issues

This document tracks friction points encountered while bootstrapping the exosuit project management system in an existing repository.

---

### F001: `exo init` Rejects Non-Empty Directories

**What happened**: Ran `exo init` in the existing SferaDev repository and got an error: "Directory is not empty. Please run 'exo init' in an empty directory."

**Why it happened**:

1. Expected `exo init` to initialize the current directory with agent-context scaffolding
2. Assumed `exo init` would detect existing files and either skip or update them
3. Didn't check for a `--force` or `--existing` flag before attempting

**What we tried**:

- Checked `exo init --help` for options → No `--force` flag exists
- Tried `exo init --format` → Wrong option, only affects output format

**Workaround**:

1. Create a temporary empty directory: `mkdir -p /tmp/exo-test && cd /tmp/exo-test`
2. Run `exo init` there (creates `docs/agent-context/` scaffolding)
3. Copy generated files to target repository: `cp -r /tmp/exo-test/docs/agent-context/* ./docs/agent-context/`
4. Write custom `plan.toml` with project-specific epochs/phases

**Fix category**: UX / Workflow

**Proposed fix**:

- Add `exo init --existing` flag to initialize agent-context in an existing directory
- Or clarify in error message: "To add exo to an existing project, manually create docs/agent-context/ and run `exo update`"

---

### F002: File Watcher Crashes Server When Files Renamed

**What happened**: While organizing RFCs (renaming `003-streaming-package.md` → `003-streaming-package.md.archived`), the exo extension server crashed with:

```
[19:43:30.033] [error] [extension] RichEditorProvider: Failed to refresh root editor
ENOENT: no such file or directory, open '.../docs/rfcs/003-streaming-package.md'
```

The server then exceeded max restart attempts (3) and became unavailable.

**Why it happened**:

1. The exo VS Code extension watches `docs/rfcs/` directory
2. When a file is renamed, the watcher receives a delete event before the create event
3. The extension tries to refresh the deleted file path and crashes
4. This pattern repeated, exceeding the 3-restart limit

**Impact**: Had to reload VS Code window and completely reinitialize exo

**Fix category**: Robustness / File Watching

**Proposed fix**:

- Add debouncing/grace period for file watcher events
- Handle ENOENT errors gracefully when refreshing editor
- Increase or remove max restart limit for development use
- Add `--dev` mode that skips file watching in RichEditorProvider

---

### F003: `exo update` Overwrites Custom plan.toml

**What happened**: After manually editing `plan.toml` with project-specific epochs, ran `exo update` and it replaced the file with a default template.

**Why it happened**:

1. `exo update` detected missing ULIDs/metadata in plan.toml
2. Regenerated the file with defaults instead of migrating existing content
3. User expectation: `exo update` would preserve and upgrade existing structure

**Impact**: Lost custom epoch/phase/task definitions

**Workaround**:

- Check git diff after `exo update` to recover lost content
- Restore from version control: `git checkout docs/agent-context/plan.toml`

**Fix category**: Data Integrity / Migration

**Proposed fix**:

- Make `exo update` migrations preserve non-default values (only add/update metadata fields)
- Add `--dry-run` flag to preview changes before applying
- Add confirmation prompt if updating would remove epochs/phases/tasks

---

### F004: VS Code Extension Exceeds Restart Limit on Startup

**What happened**: After reloading VS Code, the exo extension immediately crashed with "Server crashed: Server exited with code 1" and reported "Max restart attempts (3) exceeded".

**Why it happened**:

1. Extension tried to load `docs/agent-context/plan.toml` on startup
2. Previous crash left the server in a bad state
3. Each restart attempt failed immediately, consuming the 3-attempt budget

**Symptoms**:

- Tools like `exo-context`, `exo-status` failed with "Invalid call (failed to compile to an invocation)"
- CLI commands (`exo status`, `exo epoch list`) worked fine
- Only VS Code extension tools were broken

**Workaround**:

- Reload VS Code window again (resets the restart counter)
- Restart the extension process manually (Command Palette → "Restart Extensions")

**Fix category**: Resilience / Extension Architecture

**Proposed fix**:

- Reset restart counter after successful bootstrap sequence
- Add `/tmp/exo-extension-crashes` log file for debugging
- Implement exponential backoff instead of hard fail after 3 attempts
- Provide `exo repair` or `exo doctor` command to diagnose extension issues

---

### F005: Unclear Distinction Between CLI and LM Tool Versions

**What happened**: When exo tools were unavailable, we used subagents (`runSubagent`) instead, successfully completing work. This raises a question about when to use which.

**Observations**:

1. CLI commands work from terminal immediately: `exo epoch list`, `exo status`
2. LM tools (from VS Code extension) provide conversational interface but are fragile
3. No clear documentation on when each is appropriate

**Example use case**: "Show me the current project status"

- Option A: Use `exo-status` LM tool (if extension is working)
- Option B: Use CLI: `exo status`
- Option C: Use `runSubagent` to get a report

**Fix category**: Documentation / UX

**Proposed fix**:

- Document the relationship between LM tools and CLI commands
- Provide fallback mechanism (use CLI if LM tool unavailable)
- In VS Code, show a warning when using LM tools with known issues, offer CLI alternative

---

### F006: VS Code Extension Uses Parent Directory's agent-context

**What happened**: The `exo-status` LM tool returned data from the parent exo2 project instead of the SferaDev project, even though VS Code was opened in the SferaDev subdirectory.

**Evidence**:

```
# exo-status LM tool output:
**Epoch**: Wiring Epoch (RFC 10109)
**Phase**: RFC 10137: Transport Abstraction

# CLI output (correct):
**Epoch**: Configuration & Logging Expansion
**Phase**: Configuration Schema (RFC 005a)
```

**Why it happened**:

1. SferaDev is located at `/var/home/wycats/Code/exo2/.reference/SferaDev/`
2. Parent directory `/var/home/wycats/Code/exo2/` has its own `docs/agent-context/plan.toml` (168KB)
3. The VS Code extension walks up the directory tree to find `docs/agent-context/`
4. It finds the parent's agent-context first and uses that instead of the child's

**Impact**:

- LM tools show wrong project status
- Commands suggested by `exo-steering` are for wrong project
- Could accidentally modify wrong project's plan

**Root cause**: Missing `exosuit.toml` marker file at project root. The extension searches for this file to identify the project root, but `exo init` (when bootstrapped manually) doesn't create it.

**Fix applied**: Created `exosuit.toml` at project root:

```toml
# exosuit.toml - marks the root of the exo project
[tasks]
build = { cmd = "pnpm build", desc = "Build the extension", cwd = "packages/vscode-ai-gateway" }
```

After creating this file, LM tools correctly identified the SferaDev project.

**Fix category**: Documentation / Bootstrap UX

**Proposed upstream fix**:

- Document that `exosuit.toml` is required for workspace detection
- Have `exo init` create `exosuit.toml` (it currently doesn't)
- Add warning when `docs/agent-context/` exists but `exosuit.toml` doesn't

---

### F007: RFC Files Not Organized by Stage Directories

**What happened**: After creating RFCs and using `exo rfc promote 005a`, the CLI automatically moved the promoted RFC to a `stage-1/` subdirectory. However, the stage-0 RFCs remained in the root `docs/rfcs/` directory instead of being in a `stage-0/` subdirectory.

**Why it happened**:

1. Initial RFC creation put all files in the root of `docs/rfcs/`
2. The `exo rfc` CLI expects stage-based directory organization: `stage-0/`, `stage-1/`, `stage-2/`, etc.
3. When promoting an RFC, the CLI automatically moves the file to the next stage directory
4. But there was no documentation about this expected structure
5. The root `docs/rfcs/` directory had mixed content (README.md, stage-0 RFCs, and a stage-1 subdirectory)

**Symptoms**:

- Files not organized according to RFC lifecycle stages
- Inconsistent structure after promotion
- No clear visual organization of draft vs. accepted vs. implemented RFCs

**Fix applied**:

1. Created stage directories: `mkdir -p docs/rfcs/{stage-0,stage-1,stage-2,stage-3,stage-4,withdrawn}`
2. Moved all draft RFCs to `stage-0/`: 001, 002, 003a, 003b, 004, 005b, 005c, 007, 008, ref-stream-mapping
3. Verified 005a was already in `stage-1/` after promotion
4. Moved archived RFCs to `withdrawn/`: 003-streaming-package.md.archived, 005-configuration-enterprise.md.archived
5. Updated `docs/rfcs/README.md` to document the stage-based organization with links to stage directories
6. Removed duplicate RFC files that appeared in the root after promotion

**Fix category**: Documentation / Project Structure

**Proposed upstream documentation**:

- Document the RFC stage directory structure in the `exo rfc` help or initialization guide
- When running `exo rfc promote`, mention that the file will be moved to the next stage directory
- Update init scaffolding to create empty stage-0 through stage-4 directories
- Provide `exo rfc organize` command to automatically reorganize RFCs by stage

**Lessons learned**:

- The exo RFC CLI is opinionated about directory structure (stage-based organization)
- Promotion operations have side effects (moving files), which isn't immediately obvious
- README documentation should reflect the directory structure users will see after operations

---

## Summary

**Bootstrap Success Rate**: 85% (exo initialized, CLI works well, RFC system organized, VS Code extension needs care)

**Time Lost to Friction**: ~35 minutes (4 init attempts, 2 window reloads, file watching crash recovery, debugging wrong workspace, RFC directory reorganization)

**Current Status**:

- ✅ Exo CLI functional and well-integrated
- ✅ RFC system properly organized by stage
- ✅ Plan.toml with epochs, phases, tasks successfully managing project
- ⚠️ VS Code extension fragile (restart limits, file watcher issues)
- ⚠️ LM tools work but can have workspace detection issues

**Recommended Next Steps**:

1. File upstream issues for F001, F003, F004, F005, F006
2. Document workarounds in project README or onboarding guide
3. Consider using CLI primarily, VS Code extension as supplementary UI
4. For future projects, start with `exo init` in empty directory, then move scaffolding
5. **Avoid nesting exo projects inside other exo projects**
